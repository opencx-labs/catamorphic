/** The line-level three-way merge isomorphic-git uses (`diff3` on npm). */
declare module "diff3" {
  export type Diff3Block<T> =
    | { ok: T[] }
    | {
        conflict: {
          a: T[];
          aIndex: number;
          o: T[];
          oIndex: number;
          b: T[];
          bIndex: number;
        };
      };
  export default function diff3Merge<T>(a: T[], o: T[], b: T[]): Diff3Block<T>[];
}
