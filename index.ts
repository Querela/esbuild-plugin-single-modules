import * as esbuild from "esbuild";
import { dirname, sep as dirsep, join, parse, relative } from "node:path";

export interface singleModulesPluginOptions {
  /** filter regex for esbuild.Plugin.onResolve() method */
  filter: RegExp;
  /** number of path segments to drop from input/source files, for "./src/<file>" use 1 */
  numLevelsInputPathToDrop?: number;
}

/**
 * Strips path segments from a given path. Will take segments from the root/left.
 *
 * E.g., to drop two (2) segments:
 * - `/a/b/c/d` -> `/c/d` (absolute path)
 * - `a/b/c/d` -> `c/d` (relative path)
 * - `./a/b/c/d` -> `./c/d` (relative path, keep `./`)
 *
 * NOTE: assumes linux paths, so `/` and `.`, without any protocols!
 *
 * @param path path from which to strip segments from
 * @param numSegments the number of path segments to strip, 0 for none, -1 is erro
 * @returns path with segments stripped
 */
function reducePathLeft(path: string, numSegments: number = 0) {
  if (numSegments === 0) return path;
  if (numSegments < 0) throw new Error("numSegments must not be negative!");
  const segments = path.split(dirsep);
  if (path.startsWith(dirsep) || path.startsWith(".")) {
    return segments
      .filter((_segment, index) => index === 0 || index > numSegments)
      .join(dirsep);
  } else {
    return segments
      .filter((_segment, index) => index > numSegments - 1)
      .join(dirsep);
  }
}

export function singleModulesPlugin({
  filter = /.*/,
  numLevelsInputPathToDrop,
}: singleModulesPluginOptions): esbuild.Plugin {
  const seenFiles = new Set();
  let root: string | undefined = undefined;

  return {
    name: "singleModulesPlugin",
    setup(build) {
      // options used for build call (clone to keep a copy for build calls later)
      const options = { ...build.initialOptions };

      // update output path
      if (
        Array.isArray(options.entryPoints) &&
        options.entryPoints?.length === 1 &&
        typeof options.entryPoints[0] === "string"
      ) {
        // this will probably only be called for the initial esbuild call

        const input = options.entryPoints[0];
        const relInputDir = reducePathLeft(
          dirname(input),
          numLevelsInputPathToDrop ?? 0
        );
        const output = join(relInputDir, parse(input).name);

        // for first build call, we need to adjust the inputs/output manually
        build.initialOptions.entryPoints = [{ in: input, out: output }];
      }

      const filespecs: { in: string; out: string }[] = [];

      build.onResolve({ filter: filter }, async (args) => {
        // do nothing for "entry-point"
        if (args.kind === "entry-point") {
          if (root === undefined) {
            root = args.resolveDir;
            // console.debug("Set root path to:", root);
          }
          return undefined;
        }

        // check for supported processing
        if (args.kind !== "import-statement") {
          throw new Error(
            `Unknown import path type: "${args.kind}", expected "import-statement"`
          );
        }

        // this should now only be for "import-statement"
        const file = join(args.resolveDir, args.path);

        // only process (build) file once, then skip
        if (!seenFiles.has(file)) {
          seenFiles.add(file);

          // compute input and output names
          if (root === undefined) {
            throw new Error("Project root path couldn't be determined!");
          }
          const relInput = relative(root, file);
          const relInputDir = reducePathLeft(
            dirname(relInput),
            numLevelsInputPathToDrop ?? 0
          );

          const input = "./" + relInput;
          const output = join(relInputDir, parse(input).name);

          // console.log(
          //   "import",
          //   { path: args.path, resolveDir: args.resolveDir },
          //   { file, relInput, relInputDir, input, output }
          // );

          // store input/output for batched processing
          filespecs.push({ in: input, out: output });
        }

        // set to external, so it will not be bundled
        return { external: true };
      });

      build.onEnd(async (_result) => {
        // console.debug("[onEnd]", filespecs);
        if (filespecs.length > 0) {
          // run build on all the collected files
          await esbuild.build({
            ...options,
            entryPoints: filespecs,
          });
        }
      });
    },
  };
}
