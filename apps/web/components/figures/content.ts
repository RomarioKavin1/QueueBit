/** Figure copy shared by the client plates and the server-rendered page (plain data, no client boundary). */

export const ANATOMY_LEGEND = [
  { name: "Account", sub: "Holds your funds · ERC-8286 + 7579" },
  { name: "Keystore", sub: "Which signatures count, and for what" },
  { name: "Spending hook", sub: "Daily limits and session expiry" },
  { name: "Guardian recovery", sub: "Reset after a delay you can cancel" },
] as const;

export const MOVE_STEPS = [
  { title: "Create a passkey", body: "It guards your quantum-safe owner key on this device." },
  { title: "Connect your wallet", body: "The one you use today. QueueBit reads what it holds." },
  { title: "Sign once", body: "Your current wallet approves a single move." },
  { title: "Everything moves", body: "Tokens and ETH arrive in your quantum-safe account." },
] as const;
