// 4 AI Specialists Orchestrator (Multi-Agent Modular Underwater Restoration Pipeline)
// Coordinates the 4 domain specialists:
//   Specialist 1: Water Column & Attenuation Physics (Sea-Thru)
//   Specialist 2: Semantic Masking & Object Segmenter (SUIM / Lightroom)
//   Specialist 3: Subject Chrominance & Anti-Yellow Safeguard
//   Specialist 4: Marine Snow & Backscatter Inpainting

import { analyzeSemanticMasks } from './semanticSpecialist.js';
import { restoreWaterColumn } from './waterSpecialist.js';
import { restoreSubjectChrominance } from './subjectSpecialist.js';
import { eliminateBackscatter } from './backscatterSpecialist.js';

export {
  analyzeSemanticMasks,
  restoreWaterColumn,
  restoreSubjectChrominance,
  eliminateBackscatter,
};

export function executeSpecialistsPipeline({
  R,
  G,
  B,
  w,
  h,
  sR0,
  sG0,
  sB0,
  srcL,
  texFine,
  isGreenWater,
  isTealWater,
  subjectMask,
  params,
  look = null,
  isFreedive = true,
}) {
  const started = Date.now();

  // 1. Specialist 2: Semantic Masking & Object Segmentation (SUIM Logic)
  const semantic = analyzeSemanticMasks({
    w,
    h,
    sR0,
    sG0,
    sB0,
    srcL,
    texFine,
    isGreenWater,
    isTealWater,
    subjectMask,
    isFreedive,
  });

  // 2. Specialist 1: Water Column Engine (Sea-Thru / Physical Attenuation)
  const water = restoreWaterColumn({
    R,
    G,
    B,
    w,
    h,
    maskWater: semantic.masks.water,
    waterLightParam: params.waterLight || 0,
    waterTintParam: params.waterTint || 0,
    refMatchParam: params.refMatch || 0,
    look,
  });

  // 3. Specialist 3: Subject Chrominance Restorer (Anti Red-to-Yellow Gamut Protection)
  const subject = restoreSubjectChrominance({
    R,
    G,
    B,
    w,
    h,
    sR0,
    sG0,
    sB0,
    srcL,
    masks: semantic.masks,
    skinToneParam: params.skinTone || 0,
    redRestoreParam: params.redRestore || 0,
    isGreenWater,
    isTealWater,
    isFreedive,
  });

  // 4. Specialist 4: Backscatter & Marine Snow Eliminator
  const backscatter = eliminateBackscatter({
    R,
    G,
    B,
    w,
    h,
    spotRemovalParam: params.spotRemoval || 0,
  });

  return {
    ms: Date.now() - started,
    semantic,
    water,
    subject,
    backscatter,
  };
}
