// Keep the shipped single-bar forms and the doubled full-width form observed
// in provider output identical across tool recovery and visible-text filtering.
export const DEEPSEEK_DSML_MARKERS = ["|", "｜", "｜｜"].flatMap((bar) => [
  `${bar}DSML${bar}`,
  `${bar}DSML${bar} `,
]);
export const DEEPSEEK_DSML_TOOL_OPEN_TOKENS = DEEPSEEK_DSML_MARKERS.flatMap((marker) =>
  ["calls", "tool_calls", "tool_call", "function_calls"].map((kind) => `<${marker}${kind}>`),
);
export const DEEPSEEK_DSML_MARKER_PATTERN = `(${DEEPSEEK_DSML_MARKERS.map((marker) =>
  marker.replaceAll("|", "\\|"),
).join("|")})`;
