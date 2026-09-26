import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: "/* Cloud Relay — generated file, do not edit */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...[
      "assert", "buffer", "child_process", "cluster", "console", "constants",
      "crypto", "dgram", "dns", "domain", "events", "fs", "http", "http2",
      "https", "inspector", "module", "net", "os", "path", "perf_hooks",
      "process", "punycode", "querystring", "readline", "repl", "stream",
      "string_decoder", "timers", "tls", "trace_events", "tty", "url",
      "util", "v8", "vm", "worker_threads", "zlib",
    ],
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
