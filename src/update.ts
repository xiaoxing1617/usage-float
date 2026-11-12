// New-version check and one-click update, driven by GitHub Releases.
//
// The Tauri updater reads `latest.json` from the latest release and verifies
// the download against the public key in tauri.conf.json. If that isn't
// available for this platform, we fall back to the GitHub API so the user is
// still told about the new version and can download it from the release page.

import { isTauri } from "@tauri-apps/api/core";

export const REPO = "xiaoxing1617/usage-float";
export const REPO_URL = `https://github.com/${REPO}`;
export const RELEASES_URL = `${REPO_URL}/releases/latest`;

export type UpdatePhase = "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "error";

export interface UpdateState {
  phase: UpdatePhase;
  current: string;
  /** Newer version, without the leading "v". */
  latest?: string;
  /** true when it can be installed in place; false means "download from the release page". */
  auto?: boolean;
  /** 0–1 while downloading, when the size is known. */
  progress?: number;
  error?: string;
  checkedAt?: number;
}

type Pending = { downloadAndInstall: (cb: (e: DownloadEvent) => void) => Promise<void> };
type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

let pending: Pending | null = null;

export async function currentVersion(): Promise<string> {
  if (!isTauri()) return "0.0.0-dev";
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

/** "0.3.10" > "0.3.9"; ignores a leading "v" and any "-suffix". */
export function newer(a: string, b: string): boolean {
  const p = (v: string) =>
    v
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  }
  return false;
}

export async function checkForUpdate(current: string): Promise<UpdateState> {
  const checkedAt = Date.now();
  if (!isTauri()) {
    // Browser preview: pretend there is an update so the UI can be seen.
    return { phase: "available", current, latest: "9.9.9", auto: false, checkedAt };
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const u = await check({ timeout: 20_000 });
    pending = u;
    if (u) return { phase: "available", current, latest: u.version.replace(/^v/i, ""), auto: true, checkedAt };
    return { phase: "latest", current, checkedAt };
  } catch {
    pending = null;
  }
  // Updater manifest missing or not for this platform: ask GitHub directly.
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!r.ok) throw new Error(`http_${r.status}`);
    const tag = String((await r.json()).tag_name ?? "");
    if (tag && newer(tag, current)) {
      return { phase: "available", current, latest: tag.replace(/^v/i, ""), auto: false, checkedAt };
    }
    return { phase: "latest", current, checkedAt };
  } catch (e) {
    return { phase: "error", current, error: String(e), checkedAt };
  }
}

/** Downloads, installs and restarts. Reports progress through `on`. */
export async function installUpdate(on: (p: Partial<UpdateState>) => void): Promise<void> {
  if (!pending) throw new Error("no_update");
  let total = 0;
  let got = 0;
  on({ phase: "downloading", progress: undefined });
  await pending.downloadAndInstall((e) => {
    if (e.event === "Started") total = e.data.contentLength ?? 0;
    else if (e.event === "Progress") {
      got += e.data.chunkLength;
      if (total) on({ progress: Math.min(1, got / total) });
    } else on({ phase: "installing", progress: 1 });
  });
  on({ phase: "installing", progress: 1 });
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
