// PocketVault shared application state.
// Kept in one module so future feature modules share the same state object.
export const state = {
  user: null,
  plan: "free",
  planConfig: null,
  goals: {},
  notifications: [],
};
