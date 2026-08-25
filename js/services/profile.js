// PocketVault user-profile service extracted from app.js.
export async function loadUserProfile({ api, state }) {
  try {
    const res = await api.get("/api/user/profile");
    if (state.user) {
      Object.assign(state.user, {
        kycStatus: res.kycStatus,
        phone: res.phone,
        phoneVerified: res.phoneVerified,
        kycName: res.kycName,
        suspended: res.suspended,
        streakCount: res.streakCount,
        longestStreak: res.longestStreak,
        lastSaveWeek: res.lastSaveWeek,
        referredBy: res.referredBy,
        merchantCode: res.merchantCode,
        businessName: res.businessName,
        accountBalance: res.accountBalance,
      });
    }
    return res;
  } catch (e) {
    console.error("Failed to load user profile", e);
    return null;
  }
}
