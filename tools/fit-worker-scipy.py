import json
import math
import sys

import numpy
import scipy
from scipy.optimize import least_squares


PARAMETER_NAMES = [
    "fromCents",
    "toCents",
    "inflectionSeconds",
    "growthPerSecond",
    "asymmetryB",
]


def lcg(seed):
    state = seed & 0xFFFFFFFF
    while True:
        state = (1664525 * state + 1013904223) & 0xFFFFFFFF
        yield state / 4294967296.0


def prediction(time_seconds, parameters):
    log_inner = math.log(parameters[4]) - parameters[3] * (time_seconds - parameters[2])
    log_add = max(0.0, log_inner) + math.log1p(math.exp(-abs(log_inner)))
    value = math.exp(-log_add / parameters[4])
    start_log_inner = math.log(parameters[4]) - parameters[3] * (0.0 - parameters[2])
    start_log_add = max(0.0, start_log_inner) + math.log1p(math.exp(-abs(start_log_inner)))
    start_value = math.exp(-start_log_add / parameters[4])
    span = parameters[5] - parameters[6]
    end_log_inner = math.log(parameters[4]) - parameters[3] * (span - parameters[2])
    end_log_add = max(0.0, end_log_inner) + math.log1p(math.exp(-abs(end_log_inner)))
    end_value = math.exp(-end_log_add / parameters[4])
    unit = (value - start_value) / (end_value - start_value)
    return (1.0 - unit) * parameters[0] + unit * parameters[1]


def terminal(request, termination, code):
    return {
        "protocolVersion": 1,
        "requestId": request["requestId"],
        "operation": request["operation"],
        "engine": {"name": "scipy-least-squares", "version": scipy.__version__},
        "termination": termination,
        "parameters": None,
        "metrics": {
            "rmseCents": None,
            "maxAbsCents": None,
            "iterations": 0,
            "multiStartSpread": None,
        },
        "warnings": [{"code": code}],
    }


def fit(request):
    samples = request["samples"]
    finite_indexes = [index for index, mask in enumerate(samples["mask"]) if mask]
    if len(finite_indexes) < 11:
        return terminal(request, "rejected", "INSUFFICIENT_FINITE_SAMPLES")
    initial = request["initial"]
    bounds = request["bounds"]
    lower = numpy.array([bounds[name]["minimum"] for name in PARAMETER_NAMES], dtype=float)
    upper = numpy.array([bounds[name]["maximum"] for name in PARAMETER_NAMES], dtype=float)
    initial_values = numpy.array([initial[name] for name in PARAMETER_NAMES], dtype=float)
    time_values = numpy.array([samples["timeSeconds"][index] for index in finite_indexes], dtype=float)
    cent_values = numpy.array([samples["cents"][index] for index in finite_indexes], dtype=float)
    span_start = initial["fromSeconds"]
    span_end = initial["toSeconds"]

    def residuals(values):
        parameters = list(values)
        parameters[2] -= span_start
        parameters += [span_end, span_start]
        return numpy.array([prediction(time - span_start, parameters) for time in time_values]) - cent_values

    starts = [initial_values]
    random = lcg(request["seed"])
    for _ in range(1, request["limits"]["maxStarts"]):
        starts.append(lower + (upper - lower) * numpy.array([0.1 + next(random) * 0.8 for _ in PARAMETER_NAMES]))
    results = []
    for start in starts:
        result = least_squares(
            residuals,
            start,
            bounds=(lower, upper),
            loss="huber",
            f_scale=request["loss"]["scaleCents"],
            max_nfev=request["limits"]["maxIterations"],
            method="trf",
        )
        objective = float(numpy.mean(numpy.square(result.fun)))
        results.append((objective, result))
    results.sort(key=lambda current: current[0])
    objective, best = results[0]
    values = best.x
    fit_residuals = residuals(values)
    comparable = [
        result for other_objective, result in results
        if other_objective <= objective + max(1e-9, objective * 0.01)
    ]
    spread = 0.0
    normalized_best = (values - lower) / (upper - lower)
    for result in comparable:
        normalized = (result.x - lower) / (upper - lower)
        spread = max(spread, float(numpy.max(numpy.abs(normalized - normalized_best))))
    parameters = {
        "fromSeconds": initial["fromSeconds"],
        "toSeconds": initial["toSeconds"],
        **{name: float(values[index]) for index, name in enumerate(PARAMETER_NAMES)},
    }
    termination = "converged" if best.success else "iteration_limit"
    return {
        "protocolVersion": 1,
        "requestId": request["requestId"],
        "operation": request["operation"],
        "engine": {"name": "scipy-least-squares", "version": scipy.__version__},
        "termination": termination,
        "parameters": parameters,
        "metrics": {
            "rmseCents": float(math.sqrt(numpy.mean(numpy.square(fit_residuals)))),
            "maxAbsCents": float(numpy.max(numpy.abs(fit_residuals))),
            "iterations": int(best.nfev),
            "multiStartSpread": spread,
        },
        "warnings": [] if termination == "converged" else [{"code": "FIT_DID_NOT_CONVERGE"}],
    }


def main():
    for line in sys.stdin:
        if not line.strip():
            continue
        response = fit(json.loads(line))
        json.dump(response, sys.stdout, separators=(",", ":"), allow_nan=False)
        sys.stdout.write("\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
