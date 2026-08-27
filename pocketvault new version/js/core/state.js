// PocketVault shared application state.
// Kept in one module so future feature modules share the same state object.
export const state = {
  user: null,
  plan: "free",
  planConfig: null,
  goals: {},
  notifications: [],
  // Tracks the currently active page id. Was a module-level `let
  // currentPage` inside app.js before the module split — now lives
  // on shared state so any page/modal (e.g. save/withdraw modals
  // refreshing "wherever the user currently is" after a successful
  // action) can read it without importing app.js itself, which would
  // create a circular import back into the entry point.
  currentPage: "dashboard",
};

