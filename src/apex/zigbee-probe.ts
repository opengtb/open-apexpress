import { connect, type Socket } from "node:net";
import type { L10n } from "../recipes/types";

/**
 * Checks a network Zigbee coordinator (SLZB-06…) from this PC, the way Zigbee2MQTT starts:
 * an EZSP/ASH reset for Silicon Labs chips (ember), a Z-Stack SYS_PING for Texas Instruments
 * chips (zstack). The chip that answers tells the adapter type to use.
 *
 * The reset interrupts a Zigbee2MQTT already connected to the coordinator (it reconnects by
 * itself within seconds): the UI asks for confirmation when Zigbee2MQTT runs on the APEX.
 */

export type Adapter = "ember" | "zstack";

export interface ProbeResult {
  ok: boolean;
  detected?: Adapter;
  message: L10n;
}

const m = (fr: string, en: string): L10n => ({ fr, en });

/** ASH: cancel byte + RST frame. The NCP answers with RSTACK (0xC1 0x02 …). */
const ASH_RESET = Buffer.from([0x1a, 0xc0, 0x38, 0xbc, 0x7e]);
/** Z-Stack MT: SYS_PING request (SOF, len 0, cmd 0x21 0x01, FCS). The answer is an SRSP 0x61 0x01. */
const ZNP_PING = Buffer.from([0xfe, 0x00, 0x21, 0x01, 0x20]);

function open(host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => (socket.destroy(), reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))), timeoutMs);
    socket.once("connect", () => (clearTimeout(timer), resolve(socket)));
    socket.once("error", (e) => (clearTimeout(timer), reject(e)));
  });
}

/** Sends a frame and resolves with true as soon as `answered` matches the bytes received. */
async function ask(host: string, port: number, frame: Buffer, answered: (data: Buffer) => boolean, timeoutMs: number): Promise<boolean> {
  const socket = await open(host, port, timeoutMs);
  return new Promise((resolve) => {
    let data = Buffer.alloc(0);
    const done = (result: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (answered(data)) done(true);
    });
    socket.on("error", () => done(false));
    socket.on("close", () => done(answered(data)));
    socket.write(frame);
  });
}

const hasSequence = (data: Buffer, seq: number[]) => data.some((_, i) => seq.every((b, j) => data[i + j] === b));

export async function probeCoordinator(host: string, port: number, timeoutMs = 3000): Promise<ProbeResult> {
  const target = `${host}:${port}`;
  try {
    if (await ask(host, port, ASH_RESET, (d) => hasSequence(d, [0xc1, 0x02]), timeoutMs)) {
      return { ok: true, detected: "ember", message: m(`Coordinateur joignable sur ${target} : puce Silicon Labs, type « ember ».`, `Coordinator reachable on ${target}: Silicon Labs chip, type "ember".`) };
    }
    if (await ask(host, port, ZNP_PING, (d) => hasSequence(d, [0x61, 0x01]), timeoutMs)) {
      return { ok: true, detected: "zstack", message: m(`Coordinateur joignable sur ${target} : puce Texas Instruments, type « zstack ».`, `Coordinator reachable on ${target}: Texas Instruments chip, type "zstack".`) };
    }
    return {
      ok: false,
      message: m(
        `${target} accepte la connexion mais la puce Zigbee ne répond pas. Vérifiez qu'il est en mode « Coordinateur Zigbee » et qu'aucun autre système (Home Assistant, autre Zigbee2MQTT) ne l'utilise, puis redémarrez-le.`,
        `${target} accepts the connection but the Zigbee chip does not answer. Check it is in "Zigbee coordinator" mode and that no other system (Home Assistant, another Zigbee2MQTT) uses it, then restart it.`,
      ),
    };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ECONNREFUSED") {
      return {
        ok: false,
        message: m(
          `${host} répond mais le port ${port} est fermé : coordinateur pas en mode réseau (Ethernet/LAN) ou mauvais port.`,
          `${host} answers but port ${port} is closed: coordinator not in network (Ethernet/LAN) mode, or wrong port.`,
        ),
      };
    }
    return {
      ok: false,
      message: m(
        `${target} injoignable depuis ce PC : coordinateur éteint, débranché, ou mauvaise IP (${code ?? (e as Error).message}).`,
        `${target} unreachable from this PC: coordinator powered off, unplugged, or wrong IP (${code ?? (e as Error).message}).`,
      ),
    };
  }
}
