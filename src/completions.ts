import type { AutocompleteItem } from "@earendil-works/pi-tui";

const SUBCOMMANDS = [
  { value: "list", label: "list", description: "List session caps and remaining quota" },
  { value: "status", label: "status", description: "Alias for list" },
  { value: "set", label: "set", description: "Set a cap: <points> [session]" },
  { value: "clear", label: "clear", description: "Clear a cap: [session]" },
  { value: "clear-all", label: "clear-all", description: "Clear every session cap" },
  { value: "skim", label: "skim", description: "Fund current quota: [points], default 10" },
] satisfies AutocompleteItem[];

export function quotaCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const prefix = argumentPrefix.trimStart();
  // Only complete the first argument, never replace points or session names.
  if (/\s/.test(prefix)) return null;
  const matches = SUBCOMMANDS.filter(({ value }) => value.startsWith(prefix));
  return matches.length ? matches : null;
}
