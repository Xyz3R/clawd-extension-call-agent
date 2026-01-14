import { spawn } from "node:child_process";
import { PluginConfig } from "./config.js";

export type TunnelInfo = {
  publicUrl?: string;
  process?: ReturnType<typeof spawn>;
};

function isCommandAvailable(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ["--version"], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function startNgrok(port: number): Promise<TunnelInfo> {
  const ngrok = spawn("ngrok", ["http", `${port}`, "--log=stdout", "--log-format=json"], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let publicUrl: string | undefined;
  const waitForUrl = new Promise<string | undefined>((resolve) => {
    ngrok.stdout?.on("data", (chunk) => {
      const lines = chunk.toString("utf8").split("\n");
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.msg === "started tunnel" && obj.url) {
            publicUrl = obj.url;
            resolve(publicUrl);
          }
        } catch {
          // ignore
        }
      }
    });
    setTimeout(() => resolve(publicUrl), 5000);
  });

  return { publicUrl: await waitForUrl, process: ngrok };
}

async function startTailscaleFunnel(port: number): Promise<TunnelInfo> {
  const target = `http://127.0.0.1:${port}`;
  const args = ["funnel", "--bg", "--yes", "--https=443", target];
  const ts = spawn("tailscale", args, { stdio: ["ignore", "pipe", "pipe"] });

  let publicUrl: string | undefined;
  const waitForUrl = new Promise<string | undefined>((resolve) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const match = text.match(/https?:\/\/[^\s]+/);
      if (match) {
        publicUrl = match[0];
        resolve(publicUrl);
      }
    };
    ts.stdout?.on("data", onData);
    ts.stderr?.on("data", onData);
    setTimeout(() => resolve(publicUrl), 5000);
  });

  return { publicUrl: await waitForUrl, process: ts };
}

export async function ensurePublicUrl(config: PluginConfig, port: number): Promise<TunnelInfo> {
  if (config.server.publicBaseUrl) {
    return { publicUrl: config.server.publicBaseUrl };
  }

  if (config.tunnel.provider === "none") return {};

  const provider = config.tunnel.provider;
  if (provider === "ngrok" || provider === "auto") {
    if (await isCommandAvailable("ngrok")) {
      return startNgrok(port);
    }
    if (provider === "ngrok") return {};
  }

  if (provider === "tailscale" || provider === "auto") {
    if (await isCommandAvailable("tailscale")) {
      return startTailscaleFunnel(port);
    }
  }

  return {};
}
