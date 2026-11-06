"use client";

import { DitherSet, Label, easeInOut, easeOut, lerp, seg, useNarrow, usePlate, useTone } from "@/components/paper/kit";

/**
 * Figure 4. LeanPool. Post-quantum signatures are large, so none of them goes on chain: a LeanPool node checks each
 * one, batches them under a Merkle root and posts only the root. The account's check is one question: is my
 * transaction in a root my aggregator posted? Phones get the same drawing laid out top to bottom.
 */

const CYCLE = 7.4;
const STILL = 6.0;
const SIGS = 4;

interface Layout {
  view: [number, number];
  /** Where each queued signature waits, and the queue's label. */
  queue: (i: number) => [number, number];
  queueW: number;
  queueLabel: [number, number];
  /** The arrow from the queue to the node. */
  feed: string;
  node: { x: number; y: number; w: number; h: number };
  caption: [number, number];
  blocks: Array<[number, number]>;
  chainLabel: [number, number];
  account: [number, number];
  ask: { x: number; y: number; anchor: "start" | "end" };
  /** The account's dashed question to the newest block. */
  askPath: string;
}

const WIDE: Layout = {
  view: [740, 300],
  queue: (i) => [20, 52 + i * 44],
  queueW: 170,
  queueLabel: [20, 26],
  feed: "M196 140 C 240 140, 260 152, 294 152",
  node: { x: 300, y: 92, w: 150, h: 120 },
  caption: [300, 230],
  blocks: [500, 560, 620, 680].map((x) => [x, 120] as [number, number]),
  chainLabel: [500, 104],
  account: [578, 250],
  ask: { x: 540, y: 268, anchor: "end" },
  askPath: "M578 250 C 578 200, 698 210, 698 160",
};

const TALL: Layout = {
  view: [340, 660],
  queue: (i) => [20, 52 + i * 34],
  queueW: 150,
  queueLabel: [20, 26],
  feed: "M176 160 C 236 176, 236 282, 198 296",
  node: { x: 40, y: 238, w: 150, h: 120 },
  caption: [40, 376],
  blocks: [40, 100, 160, 220].map((x) => [x, 440] as [number, number]),
  chainLabel: [40, 426],
  account: [94, 570],
  ask: { x: 160, y: 590, anchor: "start" },
  askPath: "M94 570 C 94 520, 238 530, 238 480",
};

export function FigLeanPool() {
  return <Drawing L={useNarrow() ? TALL : WIDE} />;
}

function Drawing({ L }: { L: Layout }) {
  const { t, still, uid } = usePlate();
  const tone = useTone();
  const tc = still ? STILL : t % CYCLE;
  const out = 1 - seg(tc, 6.8, 7.3);
  const { node, blocks } = L;
  const post = easeInOut(seg(tc, 3.1, 4.3));
  const check = easeOut(seg(tc, 4.6, 5.8));
  const last = blocks[3]!;

  // the batch's Merkle tree, inside the node
  const cx = node.x + 108;
  const leaves = [0, 1, 2, 3].map((i) => [cx - 27 + i * 18, node.y + 92] as const);
  const mids = [0, 1].map((i) => [cx - 18 + i * 36, node.y + 62] as const);
  const root = [cx, node.y + 32] as const;
  const grow = seg(tc, 2.3, 3.0);

  return (
    <svg viewBox={`0 0 ${L.view[0]} ${L.view[1]}`} className="w-full" aria-hidden>
      <DitherSet />
      <Label x={L.queueLabel[0]} y={L.queueLabel[1]} tone="ink" size={10}>
        Owner-signed transactions
      </Label>
      {/* the queue they came from, kept as a ghost so the drawing reads at rest */}
      {Array.from({ length: SIGS }, (_, i) => {
        const [x, y] = L.queue(i);
        return (
          <g key={`q${i}`}>
            <rect
              x={x}
              y={y}
              width={L.queueW}
              height={13}
              fill="none"
              stroke="var(--blue-2)"
              strokeWidth={0.7}
              strokeDasharray="2 3"
            />
            <text
              x={x + 4}
              y={y - 4}
              fontFamily="var(--font-label), monospace"
              fontSize={8}
              fill="var(--ink-3)"
              letterSpacing="0.04em"
            >
              {`SIG ${i + 1} · 4,276 B`}
            </text>
          </g>
        );
      })}
      <path d={L.feed} fill="none" stroke="var(--ink-3)" strokeWidth={0.8} markerEnd={`url(#${uid}-arrow-ink)`} />
      {/* signatures arriving, each checked */}
      {Array.from({ length: SIGS }, (_, i) => {
        const p = easeInOut(seg(tc, 0.2 + i * 0.35, 1.7 + i * 0.35));
        const [qx, qy] = L.queue(i);
        const x = lerp(qx, node.x + 18, p);
        const y = lerp(qy, node.y + 26 + i * 18, p);
        const w = lerp(L.queueW, 10, seg(p, 0.75, 1));
        const verified = seg(tc, 1.9 + i * 0.35, 2.1 + i * 0.35);
        return (
          <g key={i} opacity={out}>
            <rect x={x} y={y} width={w} height={13} fill={tone("b8")} stroke="var(--blue)" strokeWidth={0.8} />
            {verified > 0 && (
              <path
                d={`M${node.x + 36} ${node.y + 32 + i * 18} l4 4 l8 -9`}
                fill="none"
                stroke="var(--blue)"
                strokeWidth={1.4}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={1 - verified}
              />
            )}
          </g>
        );
      })}
      {/* the node */}
      <rect x={node.x} y={node.y} width={node.w} height={node.h} fill="none" stroke="var(--ink-2)" strokeWidth={1} />
      <Label x={node.x} y={node.y - 10} tone="ink" size={10}>
        LeanPool node
      </Label>
      <text x={L.caption[0]} y={L.caption[1]} fontSize={11} fontStyle="italic" fill="var(--ink-2)">
        verifies off chain, batches
      </text>
      <g opacity={grow * out}>
        {leaves.map(([x, y], i) => (
          <line
            key={`l${i}`}
            x1={x}
            y1={y - 4}
            x2={mids[i >> 1]![0]}
            y2={mids[i >> 1]![1] + 4}
            stroke="var(--blue-2)"
            strokeWidth={0.8}
          />
        ))}
        {mids.map(([x, y], i) => (
          <line
            key={`m${i}`}
            x1={x}
            y1={y - 4}
            x2={root[0]}
            y2={root[1] + 4}
            stroke="var(--blue-2)"
            strokeWidth={0.8}
          />
        ))}
        {[...leaves, ...mids].map(([x, y], i) => (
          <rect
            key={`n${i}`}
            x={x - 4}
            y={y - 4}
            width={8}
            height={8}
            fill={tone("b4")}
            stroke="var(--blue)"
            strokeWidth={0.7}
          />
        ))}
        {post < 0.02 && (
          <rect
            x={root[0] - 5}
            y={root[1] - 5}
            width={10}
            height={10}
            fill={tone("b12")}
            stroke="var(--blue)"
            strokeWidth={0.9}
          />
        )}
      </g>
      {/* the root travels to the chain */}
      {post > 0.02 && (
        <rect
          x={lerp(root[0] - 5, last[0] + 13, post)}
          y={lerp(root[1] - 5, last[1] + 13, post)}
          width={10}
          height={10}
          fill={tone("b12")}
          stroke="var(--blue)"
          strokeWidth={0.9}
          opacity={out}
        />
      )}
      {/* the chain */}
      <Label x={L.chainLabel[0]} y={L.chainLabel[1]} tone="ink" size={10}>
        Chain
      </Label>
      {blocks.map(([x, y], i) => (
        <g key={x}>
          {i > 0 && <line x1={x - 24} y1={y + 18} x2={x} y2={y + 18} stroke="var(--ink-3)" strokeWidth={0.8} />}
          <rect
            x={x}
            y={y}
            width={36}
            height={36}
            fill={i === 3 && post >= 1 ? tone("b2") : "var(--paper)"}
            stroke="var(--ink-2)"
            strokeWidth={0.9}
          />
        </g>
      ))}
      <Label x={last[0] + 36} y={last[1] + 54} anchor="end" size={9} opacity={seg(post, 0.9, 1) * out}>
        One root · 32 B
      </Label>
      {/* the account's question */}
      <g opacity={check * out}>
        <path
          d={L.askPath}
          fill="none"
          stroke="var(--blue)"
          strokeWidth={1}
          strokeDasharray="3 3"
          markerEnd={`url(#${uid}-arrow)`}
        />
        <rect
          x={L.account[0] - 24}
          y={L.account[1]}
          width={48}
          height={28}
          fill={tone("b4")}
          stroke="var(--blue)"
          strokeWidth={0.9}
        />
        <Label x={L.account[0]} y={L.account[1] + 42} anchor="middle" size={9}>
          Your account
        </Label>
        <text x={L.ask.x} y={L.ask.y} fontSize={11.5} fontStyle="italic" fill="var(--ink)" textAnchor={L.ask.anchor}>
          is my transaction in this root?
        </text>
        <path d={`M${last[0] + 42} ${last[1] + 16} l5 5 l10 -11`} fill="none" stroke="var(--blue)" strokeWidth={1.6} />
      </g>
    </svg>
  );
}
