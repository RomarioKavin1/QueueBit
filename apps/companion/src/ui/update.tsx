import { useEffect, useState } from "react";
import { Banner, Button, Sheet } from "./kit.js";

/**
 * Manual app updates (backlog: "no silent skipWaiting + claim"). The service worker never activates itself over a
 * running app: a new build installs as the *waiting* worker, after checking every file it caches against the digests
 * its build id commits to, and this banner offers "Update available: build X → Y". Only the user's tap activates it.
 * Trust model in IMPLEMENTATION-NOTES.md ("Companion: manual, verified updates"); in short: the origin that serves
 * the app is trusted for its code (any web app's limit), and this makes a change of code visible and deliberate.
 */

export interface BuildInfo {
  /** Content hash of every file of the build (what the service worker checks). */
  version: string;
  /** The git commit it was built from. */
  build: string;
}

/** What a worker says about itself: its own build, and the build it serves (the one the user approved). */
interface WorkerInfo extends BuildInfo {
  serving: BuildInfo;
}

function post<T>(sw: ServiceWorker, msg: { type: string }): Promise<T | undefined> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const t = window.setTimeout(() => resolve(undefined), 3000);
    ch.port1.onmessage = (e: MessageEvent<T>) => {
      window.clearTimeout(t);
      resolve(e.data);
    };
    sw.postMessage(msg, [ch.port2]);
  });
}

const ask = async (sw: ServiceWorker): Promise<WorkerInfo | undefined> => {
  const r = await post<WorkerInfo>(sw, { type: "version" });
  return r && typeof r.version === "string" && r.serving ? r : undefined;
};

export const buildLabel = (b: BuildInfo | undefined): string =>
  b ? `${b.build} · ${b.version.slice(0, 8)}` : `${__BUILD_ID__} · not installed`;

interface UpdateState {
  /** The build this page runs (served by the worker from the approved build's cache). */
  running?: BuildInfo;
  /** A newer build that is installed and verified, waiting for the user. */
  waiting?: { worker: ServiceWorker; info: BuildInfo | undefined; active: boolean };
}

let shared: UpdateState = {};
const listeners = new Set<(s: UpdateState) => void>();
const publish = (s: UpdateState) => {
  shared = s;
  for (const l of listeners) l(s);
};

let started = false;
function start(): void {
  if (started || !("serviceWorker" in navigator)) return;
  started = true;
  const sw = navigator.serviceWorker;
  const refresh = async () => {
    const reg = await sw.getRegistration();
    const ctl = sw.controller;
    const c = ctl ? await ask(ctl) : undefined;
    const w = reg?.waiting;
    let waiting: UpdateState["waiting"];
    if (w && ctl) {
      const info = await ask(w);
      waiting = { worker: w, info: info && { version: info.version, build: info.build }, active: false };
    } else if (ctl && c && c.version !== c.serving.version) {
      // The browser already activated the new worker (every old window was closed), but it still serves the
      // approved build until the user says otherwise.
      waiting = { worker: ctl, info: { version: c.version, build: c.build }, active: true };
    }
    publish({ ...(c ? { running: c.serving } : {}), ...(waiting ? { waiting } : {}) });
    if (reg && !reg.onupdatefound)
      reg.onupdatefound = () => {
        const inst = reg.installing;
        inst?.addEventListener("statechange", () => {
          if (inst.state === "installed") void refresh();
        });
      };
  };
  void refresh();
  // Activated only after the user's tap (or, as browsers do, once every window of the old build is closed): reload
  // into the new build so no page keeps running old code against new caches.
  let reloading = false;
  sw.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

export function useAppUpdate(): UpdateState & { apply: () => void } {
  const [s, setS] = useState<UpdateState>(shared);
  useEffect(() => {
    listeners.add(setS);
    start();
    setS(shared);
    return () => void listeners.delete(setS);
  }, []);
  return {
    ...s,
    apply: () => {
      const w = s.waiting;
      if (!w) return;
      // A waiting worker takes over (controllerchange → reload above); an active one just switches what it serves.
      void post(w.worker, { type: "activate" }).then(() => {
        if (w.active) window.location.reload();
      });
    },
  };
}

export function UpdateBanner() {
  const u = useAppUpdate();
  const [confirm, setConfirm] = useState(false);
  if (!u.waiting) return null;
  const from = buildLabel(u.running);
  const to = u.waiting.info ? buildLabel(u.waiting.info) : "unknown";
  return (
    <>
      <Banner
        level="info"
        title={`Update available: build ${from} → ${to}`}
        testId="update-banner"
        action={
          <Button variant="secondary" block={false} onClick={() => setConfirm(true)} data-testid="update-review">
            Review the update
          </Button>
        }
      >
        Nothing changes until you choose to update.
      </Banner>
      {confirm && (
        <Sheet title="Update this app?" onClose={() => setConfirm(false)}>
          <div className="flex flex-col gap-3 pb-2">
            <dl className="rounded-md border border-line px-3 py-2 t-body">
              <div className="flex justify-between gap-2">
                <dt className="text-muted">Running</dt>
                <dd className="t-mono" data-testid="update-from">
                  {from}
                </dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted">New</dt>
                <dd className="t-mono" data-testid="update-to">
                  {to}
                </dd>
              </div>
            </dl>
            <p className="t-body">
              Every file of the new build was checked against the fingerprints that build carries, so the download is
              complete and not a mix of builds. That check can't tell a genuine build from one served by a compromised
              site: if you can, compare the new build id with the one QueueBit publishes for this release before you
              update.
            </p>
            <p className="t-small text-muted">
              Your Vault, address book and history stay on this phone. Don't update in the middle of an approval.
            </p>
            <Button
              variant="vault"
              onClick={() => {
                setConfirm(false);
                u.apply();
              }}
              data-testid="update-apply"
            >
              Update now
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Not now
            </Button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/** The build id, shown on Home and in About so a user can tell builds apart (and check one). */
export function BuildLine() {
  const u = useAppUpdate();
  return (
    <p className="mt-auto pt-2 text-center t-small text-muted" data-testid="build-line">
      Build <span className="t-mono">{buildLabel(u.running)}</span>
    </p>
  );
}
