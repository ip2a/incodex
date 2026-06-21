export function serializeInlineScript<TConfig>(
  script: (config: TConfig) => void,
  config: TConfig,
): string {
  const serializedConfig = JSON.stringify(config).replaceAll("<", "\\u003c");
  return [
    "(() => {",
    "  const __name = (target) => target;",
    `  (${script.toString()})(${serializedConfig});`,
    "})();",
  ].join("\n");
}
