"""A small Levenberg-Marquardt least-squares solver, so the add-on doesn't need SciPy.

Forward-difference Jacobian, Marquardt scaling (damping on diag(JᵀJ)), and an optional soft-L1
robust loss (rho(z) = 2(sqrt(1 + z) - 1), z = (r / f_scale)², as SciPy's `least_squares`), done by
iteratively reweighting the residuals. Sized for the mapping problems: a 4-parameter frame
alignment and a bundle adjustment with about 60 parameters.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np


def _cost(r: np.ndarray, loss: str, f_scale: float) -> float:
    if loss == "soft_l1":
        z = (r / f_scale) ** 2
        return float(f_scale**2 * (2 * (np.sqrt(1 + z) - 1)).sum())
    return float((r * r).sum())


def _weights(r: np.ndarray, loss: str, f_scale: float) -> np.ndarray:
    if loss == "soft_l1":
        return 1.0 / np.sqrt(np.sqrt(1 + (r / f_scale) ** 2))  # sqrt(rho'(z))
    return np.ones_like(r)


def jacobian(fun: Callable[[np.ndarray], np.ndarray], x: np.ndarray, r0: np.ndarray) -> np.ndarray:
    J = np.empty((len(r0), len(x)))
    for i in range(len(x)):
        h = 1e-6 * max(1.0, abs(x[i]))
        xp = x.copy()
        xp[i] += h
        J[:, i] = (fun(xp) - r0) / h
    return J


def least_squares(
    fun: Callable[[np.ndarray], np.ndarray],
    x0: np.ndarray,
    *,
    loss: str = "linear",
    f_scale: float = 1.0,
    max_iter: int = 100,
    tol: float = 1e-10,
) -> np.ndarray:
    """Minimise sum(loss(fun(x)²)). Returns the solution."""
    x = np.asarray(x0, float).copy()
    r = fun(x)
    cost = _cost(r, loss, f_scale)
    lam = 1e-3
    for _ in range(max_iter):
        J = jacobian(fun, x, r)
        w = _weights(r, loss, f_scale)
        Jw = J * w[:, None]
        rw = r * w
        A = Jw.T @ Jw
        g = Jw.T @ rw
        if np.max(np.abs(g)) < tol:
            break
        diag = np.maximum(np.diag(A), 1e-12)
        improved = False
        for _ in range(12):
            try:
                step = np.linalg.solve(A + lam * np.diag(diag), -g)
            except np.linalg.LinAlgError:
                lam *= 10
                continue
            xn = x + step
            rn = fun(xn)
            cn = _cost(rn, loss, f_scale)
            if np.isfinite(cn) and cn < cost:
                small = cost - cn < tol * max(cost, 1e-12) or np.linalg.norm(step) < tol * (
                    np.linalg.norm(x) + tol
                )
                x, r, cost = xn, rn, cn
                lam = max(lam / 3, 1e-12)
                improved = True
                break
            lam *= 4
        if not improved or small:
            break
    return x
