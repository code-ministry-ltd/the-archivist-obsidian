import type { Api } from "./api.ts";

// Device sign-in (spec 0005 §3.1): start a request, show the code and open the approval page,
// then poll until the person answers.

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresIn: number;
}

export type ConnectOutcome =
  | { status: "approved"; token: string }
  | { status: "declined" }
  | { status: "expired" }
  | { status: "cancelled" };

export function startConnecting(api: Api, device: string, root: string): Promise<DeviceStart> {
  return api.post<DeviceStart>("/api/device/start", { client: "obsidian", device, root });
}

export async function waitForApproval(
  api: Api,
  start: DeviceStart,
  { sleep, cancelled }: { sleep: (ms: number) => Promise<void>; cancelled: () => boolean },
): Promise<ConnectOutcome> {
  const deadline = Date.now() + start.expiresIn * 1000;
  let interval = start.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    if (cancelled()) return { status: "cancelled" };
    let answer: { status: string; token?: string };
    try {
      answer = await api.post("/api/device/token", { deviceCode: start.deviceCode });
    } catch (err) {
      // Polled too fast, or a blip: wait longer and carry on until the request expires.
      interval = Math.min(interval * 2, 30_000);
      void err;
      continue;
    }
    if (answer.status === "approved" && answer.token) return { status: "approved", token: answer.token };
    if (answer.status === "declined") return { status: "declined" };
    if (answer.status === "expired") return { status: "expired" };
  }
  return { status: "expired" };
}
