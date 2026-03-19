const path = require("path");
const CopyPlugin = require("copy-webpack-plugin");

module.exports = (env, argv) => {
  const isDev = argv.mode === "development";

  return [
    // index.js — plugin sandbox (runs in Joplin's plugin sandbox)
    {
      entry: "./src/index.ts",
      target: "node",
      output: {
        filename: "index.js",
        path: path.resolve(__dirname, "dist"),
      },
      resolve: {
        extensions: [".ts", ".js"],
        alias: {
          // Joplin injects 'joplin' as a global variable in the plugin sandbox.
          // This shim re-exports it so `import joplin from "api"` works.
          "api": path.resolve(__dirname, "src", "api-shim.js"),
        },
      },
      module: {
        rules: [
          { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ },
        ],
      },
      devtool: isDev ? "source-map" : false,
    },
    // panel.js — editor webview (runs in browser-like context)
    {
      entry: "./src/panel.ts",
      target: "web",
      output: {
        filename: "panel.js",
        path: path.resolve(__dirname, "dist"),
      },
      resolve: {
        extensions: [".ts", ".js"],
      },
      module: {
        rules: [
          { test: /\.ts$/, use: "ts-loader", exclude: /node_modules/ },
        ],
      },
      plugins: [
        new CopyPlugin({
          patterns: [
            { from: "src/styles", to: "styles" },
            { from: "src/manifest.json", to: "manifest.json" },
            { from: "node_modules/katex/dist/katex.min.css", to: "styles/katex.min.css" },
            { from: "node_modules/katex/dist/fonts", to: "styles/fonts" },
          ],
        }),
      ],
      devtool: isDev ? "source-map" : false,
    },
  ];
};
