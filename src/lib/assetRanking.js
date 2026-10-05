export function selectTopPayoutAssets(assets, limit = 10) {
  if (!Array.isArray(assets) || !Number.isInteger(limit) || limit <= 0) return [];
  return assets
    .filter((asset) =>
      asset?.isOpen === true &&
      asset.analysisSupported === true &&
      Number.isFinite(asset.payout) &&
      asset.payout > 0
    )
    .sort((left, right) =>
      right.payout - left.payout || left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .slice(0, limit);
}
