/**
 * Makes all properties of T optional recursively, including nested objects.
 * Unlike Partial<T> which only affects the top level, DeepPartial allows
 * specifying any subset of a nested structure. Arrays are preserved as-is
 * (not made element-optional) to avoid widening e.g. string[] to (string | undefined)[].
 */
export type DeepPartial<T> = T extends (infer U)[]
  ? T
  : T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T
