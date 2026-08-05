import {
  integratedLinearFrequencyPhase as referenceIntegratedLinearFrequencyPhase,
  timeVaryingVibrato as referenceTimeVaryingVibrato,
} from "./model.js";

export function integratedLinearFrequencyPhase(localSeconds, parameters) {
  return referenceIntegratedLinearFrequencyPhase(localSeconds, parameters);
}

export function timeVaryingVibrato(timeSeconds, parameters) {
  return referenceTimeVaryingVibrato(timeSeconds, parameters);
}
