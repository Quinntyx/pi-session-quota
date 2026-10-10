import { execFile } from "node:child_process";

export type TmuxCommand = (paneId: string) => Promise<string | null>;

export function queryTmuxSession(paneId: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "tmux",
      ["display-message", "-p", "-t", paneId, "#{session_name}"],
      { timeout: 2_000, maxBuffer: 16_384 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const session = stdout.replace(/\r?\n$/, "");
        resolve(session || null);
      },
    );
  });
}

export async function resolveTmuxSession(
  env: NodeJS.ProcessEnv = process.env,
  query: TmuxCommand = queryTmuxSession,
): Promise<string | null> {
  const paneId = env.TMUX_PANE;
  if (!paneId) return null;
  return query(paneId);
}
