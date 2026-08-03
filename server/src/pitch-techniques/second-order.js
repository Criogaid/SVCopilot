import {
  compileFirstPeakTransient,
  firstPeakAngularFactor as referenceFirstPeakAngularFactor,
  secondOrderImpulse as referenceSecondOrderImpulse,
  secondOrderImpulseDerivative as referenceSecondOrderImpulseDerivative,
  TRANSIENT_TAPER_RATIO as referenceTransientTaperRatio,
} from "../../../docs/pitch-techniques/reference/model.mjs";

export const TRANSIENT_TAPER_RATIO = referenceTransientTaperRatio;

export function secondOrderImpulse(timeSeconds, parameters) {
  return referenceSecondOrderImpulse(timeSeconds, parameters);
}

export function secondOrderImpulseDerivative(timeSeconds, parameters) {
  return referenceSecondOrderImpulseDerivative(timeSeconds, parameters);
}

export function firstPeakAngularFactor(dampingRatio) {
  return referenceFirstPeakAngularFactor(dampingRatio);
}

export function transientFromFirstPeak(parameters) {
  return compileFirstPeakTransient(parameters);
}
