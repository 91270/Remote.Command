// Remote.Command: deterministic local flags. No cache or network refresh.
export const featureFlagManager = {
  initialize: async () => {},
  get: (_name, fallback = false) => fallback,
  getAll: () => ({}),
  refresh: async () => true,
  wasLoadedFromCache: () => true,
  waitForFreshFlags: async () => {},
  dispose: () => {}
};
