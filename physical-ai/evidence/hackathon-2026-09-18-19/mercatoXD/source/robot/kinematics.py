#!/usr/bin/env python3
"""Minimal URDF serial-chain kinematics in numpy. No pinocchio, no ROS.

Enough for retargeting one arm onto another: FK, geometric Jacobian, and a
damped-least-squares IK that respects joint limits.
"""
from __future__ import annotations
import xml.etree.ElementTree as ET
import numpy as np


def _rpy(r, p, y):
    cr, sr, cp, sp, cy, sy = np.cos(r), np.sin(r), np.cos(p), np.sin(p), np.cos(y), np.sin(y)
    return np.array([[cy*cp, cy*sp*sr - sy*cr, cy*sp*cr + sy*sr],
                     [sy*cp, sy*sp*sr + cy*cr, sy*sp*cr - cy*sr],
                     [-sp,   cp*sr,            cp*cr]])


def _T(R, p):
    T = np.eye(4); T[:3, :3] = R; T[:3, 3] = p
    return T


class Joint:
    __slots__ = ("name","parent","child","type","xyz","rpy","axis","lower","upper")
    def __init__(self, e):
        self.name = e.get("name"); self.type = e.get("type")
        self.parent = e.find("parent").get("link"); self.child = e.find("child").get("link")
        o = e.find("origin")
        self.xyz = np.array([float(x) for x in (o.get("xyz") if o is not None and o.get("xyz") else "0 0 0").split()])
        self.rpy = np.array([float(x) for x in (o.get("rpy") if o is not None and o.get("rpy") else "0 0 0").split()])
        a = e.find("axis")
        self.axis = np.array([float(x) for x in (a.get("xyz") if a is not None else "0 0 1").split()])
        n = np.linalg.norm(self.axis)
        if n > 0: self.axis = self.axis / n
        l = e.find("limit")
        self.lower = float(l.get("lower")) if l is not None and l.get("lower") else -np.pi
        self.upper = float(l.get("upper")) if l is not None and l.get("upper") else  np.pi


class Chain:
    """Serial chain through the named actuated joints, in order."""
    def __init__(self, urdf_path, joint_names):
        root = ET.parse(urdf_path).getroot()
        self.all = {}
        for e in root.findall("joint"):
            j = Joint(e); self.all[j.name] = j
        missing = [n for n in joint_names if n not in self.all]
        if missing: raise KeyError(f"{urdf_path}: missing joints {missing}")
        self.names = list(joint_names)
        self.joints = [self.all[n] for n in self.names]
        # fixed joints sitting between actuated ones must be composed in
        self.pre = [self._fixed_between(i) for i in range(len(self.names))]
        self.lower = np.array([j.lower for j in self.joints])
        self.upper = np.array([j.upper for j in self.joints])

    def _parent_chain(self, link):
        """Walk up from `link` to the root, returning joints child->parent."""
        out = []
        by_child = {j.child: j for j in self.all.values()}
        while link in by_child:
            j = by_child[link]; out.append(j); link = j.parent
        return out

    def _fixed_between(self, i):
        """Fixed transforms between actuated joint i-1's child and joint i."""
        target = self.joints[i]
        stop = self.joints[i-1].child if i > 0 else None
        Ts = []
        up = self._parent_chain(target.parent)
        for j in up:
            if j.child == stop or j.name in self.names: break
            if j.type == "fixed": Ts.append(_T(_rpy(*j.rpy), j.xyz))
        T = np.eye(4)
        for t in reversed(Ts): T = T @ t
        return T

    def fk(self, q, upto=None):
        T = np.eye(4)
        n = len(self.joints) if upto is None else upto
        for i in range(n):
            j = self.joints[i]
            T = T @ self.pre[i] @ _T(_rpy(*j.rpy), j.xyz)
            if j.type in ("revolute", "continuous"):
                a = j.axis; c, s = np.cos(q[i]), np.sin(q[i])
                K = np.array([[0,-a[2],a[1]],[a[2],0,-a[0]],[-a[1],a[0],0]])
                T = T @ _T(np.eye(3) + s*K + (1-c)*(K@K), np.zeros(3))
            elif j.type == "prismatic":
                T = T @ _T(np.eye(3), j.axis * q[i])
        return T

    def fk_jac(self, q):
        """Tip pose and geometric Jacobian in one pass (ik calls this per step)."""
        N = len(self.joints)
        Ts = []; T = np.eye(4)
        for i in range(N):
            j = self.joints[i]
            T = T @ self.pre[i] @ _T(_rpy(*j.rpy), j.xyz)
            Ts.append(T.copy())
            if j.type in ("revolute", "continuous"):
                a = j.axis; c, s = np.cos(q[i]), np.sin(q[i])
                K = np.array([[0,-a[2],a[1]],[a[2],0,-a[0]],[-a[1],a[0],0]])
                T = T @ _T(np.eye(3) + s*K + (1-c)*(K@K), np.zeros(3))
            elif j.type == "prismatic":
                T = T @ _T(np.eye(3), j.axis * q[i])
        pe = T[:3, 3]; J = np.zeros((6, N))
        for i in range(N):
            j = self.joints[i]
            zi = Ts[i][:3, :3] @ j.axis; pi = Ts[i][:3, 3]
            if j.type == "prismatic":
                J[:3, i] = zi
            else:
                J[:3, i] = np.cross(zi, pe - pi); J[3:, i] = zi
        return T, J

    def jacobian(self, q):
        """Geometric Jacobian at the tip, base frame. 6 x N."""
        N = len(self.joints)
        Te = self.fk(q); pe = Te[:3, 3]
        J = np.zeros((6, N))
        T = np.eye(4)
        for i in range(N):
            j = self.joints[i]
            T = T @ self.pre[i] @ _T(_rpy(*j.rpy), j.xyz)
            zi = T[:3, :3] @ j.axis; pi = T[:3, 3]
            if j.type == "prismatic":
                J[:3, i] = zi
            else:
                J[:3, i] = np.cross(zi, pe - pi); J[3:, i] = zi
            if j.type in ("revolute", "continuous"):
                a = j.axis; c, s = np.cos(q[i]), np.sin(q[i])
                K = np.array([[0,-a[2],a[1]],[a[2],0,-a[0]],[-a[1],a[0],0]])
                T = T @ _T(np.eye(3) + s*K + (1-c)*(K@K), np.zeros(3))
            elif j.type == "prismatic":
                T = T @ _T(np.eye(3), j.axis * q[i])
        return J


def pose_error(Tc, Td):
    """6-vector [dp, dw] taking current pose to desired."""
    dp = Td[:3, 3] - Tc[:3, 3]
    R = Td[:3, :3] @ Tc[:3, :3].T
    w = np.array([R[2,1]-R[1,2], R[0,2]-R[2,0], R[1,0]-R[0,1]])
    s = np.linalg.norm(w)
    if s < 1e-9:
        dw = np.zeros(3)
    else:
        ang = np.arctan2(s/2.0, (np.trace(R)-1)/2.0)
        dw = w / s * ang
    return np.concatenate([dp, dw])


def ik(chain, T_des, q0, iters=80, tol_p=1e-4, tol_w=2e-3,
       damping=0.05, w_rot=0.3, q_bias=None, k_bias=0.02, step_clip=0.25):
    """Levenberg-Marquardt IK with limit clamping and a null-space bias.

    Damping scales with the residual: heavy far away (stable through
    singularities), light close in (fast final convergence). Fixed damping
    either stalls near the target or goes unstable far from it.
    """
    q = np.array(q0, dtype=float)
    W = np.ones(6); W[3:] = w_rot
    for _ in range(iters):
        Tc, J = chain.fk_jac(q)
        e = pose_error(Tc, T_des)
        en = np.linalg.norm(e[:3])
        if en < tol_p and np.linalg.norm(e[3:]) < tol_w:
            break
        lam = max(1e-3, min(damping, damping * en / 0.02))
        Jw = J * W[:, None]; ew = e * W
        JT = Jw.T
        dq = JT @ np.linalg.solve(Jw @ JT + (lam**2)*np.eye(6), ew)
        if q_bias is not None:                       # resolve redundancy
            N = np.eye(len(q)) - JT @ np.linalg.solve(Jw @ JT + (lam**2)*np.eye(6), Jw)
            dq += N @ (k_bias * (np.asarray(q_bias) - q))
        m = np.max(np.abs(dq))
        if m > step_clip: dq *= step_clip / m
        q = np.clip(q + dq, chain.lower, chain.upper)
    return q, chain.fk(q)
