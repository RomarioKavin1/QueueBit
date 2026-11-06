"use client";

import { useState } from "react";
import { Address, Notice, Primary, Screen, Secondary, Title } from "@/components/onboarding/ui";
import { VReceive } from "@/components/onboarding/vignettes";
import { Qr } from "./Qr";
import { useWallet } from "./state";
import type { Nav } from "./Wallet";

export function Receive({ nav }: { nav: Nav }) {
  const { status, net } = useWallet();
  const [copied, setCopied] = useState(false);
  const address = status?.address;
  const canShare = typeof navigator !== "undefined" && "share" in navigator;

  const copy = () =>
    address &&
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  return (
    <Screen
      onBack={nav.back}
      method="Receive"
      actions={
        address ? (
          <>
            <Primary onClick={copy}>{copied ? "Copied" : "Copy address"}</Primary>
            {canShare && (
              <Secondary onClick={() => void navigator.share({ text: address }).catch(() => undefined)}>
                Share
              </Secondary>
            )}
          </>
        ) : undefined
      }
    >
      <VReceive />
      <Title sub={`Send only ${net?.name ?? "test network"} ETH here.`}>Your address</Title>
      {address && (
        <div className="plate-grid relative grid place-items-center px-5 pt-8 pb-6">
          <span aria-hidden className="fig-tag absolute top-3 right-2">
            [ ADDRESS ]
          </span>
          <div className="border border-ink p-2">
            <Qr value={address} size={208} label={`QR code of ${address}`} />
          </div>
          <Address value={address} className="mt-6 block text-center text-[1.12rem] leading-[1.7]" />
        </div>
      )}
      {status && !status.deployed && (
        <Notice>The address works before the account is created. Funds sent now wait for it.</Notice>
      )}
    </Screen>
  );
}
