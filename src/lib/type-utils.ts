/**
 * Makes all properties of T optional recursively, including nested objects.
 * Unlike Partial<T> which only affects the top level, DeepPartial allows
 * specifying any subset of a nested structure.
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T
