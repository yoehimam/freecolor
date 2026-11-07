// FreeColor - thin facade over the in-device engine. Everything runs locally
// (no server, no account, no quota). AI is a separate, optional module: see ai.js.
import { offlineEngine } from './offlineEngine.js';

export const api = {
  upload: (file, gear = 'umum') => offlineEngine.uploadPhoto(file, gear),
  render: (assetId, params, edge = 1600) => offlineEngine.renderPhoto(assetId, params, edge),
  exportHighRes: (assetId, params, mime) => offlineEngine.exportHighRes(assetId, params, mime),
  removeAsset: (assetId) => offlineEngine.removeAsset(assetId),
};
