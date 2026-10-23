import {
  SPACE_BACKDROP_RUNTIME_KEY,
  addMediaChangeListener,
  createSpaceBackdropRuntime,
  destroySpaceBackdrop
} from "./spaceBackdropCore.js";

const SPACE_BACKDROP_TRAIL_SELECTOR = "[data-space-backdrop-trail]";
const SPACE_BACKDROP_TRAIL_PROFILE = Object.freeze({
  delayMaxMs: 6200,
  delayMinMs: 1800,
  durationMaxMs: 1480,
  durationMinMs: 960,
  initialDelayMaxMs: 2200,
  initialDelayMinMs: 280,
  lengthMaxRem: 12.6,
  lengthMinRem: 8.4,
  travelMaxVmax: 72,
  travelMinVmax: 38,
  directionPools: Object.freeze([
    Object.freeze({ angleMaxDeg: 34, angleMinDeg: 16, leftMax: 48, leftMin: 6, topMax: 44, topMin: 4 }),
    Object.freeze({ angleMaxDeg: 58, angleMinDeg: 38, leftMax: 34, leftMin: 4, topMax: 26, topMin: 2 }),
    Object.freeze({ angleMaxDeg: 166, angleMinDeg: 144, leftMax: 94, leftMin: 52, topMax: 50, topMin: 6 }),
    Object.freeze({ angleMaxDeg: 122, angleMinDeg: 102, leftMax: 96, leftMin: 66, topMax: 28, topMin: 2 }),
    Object.freeze({ angleMaxDeg: -14, angleMinDeg: -34, leftMax: 52, leftMin: 8, topMax: 92, topMin: 42 }),
    Object.freeze({ angleMaxDeg: 214, angleMinDeg: 194, leftMax: 92, leftMin: 50, topMax: 90, topMin: 46 })
  ])
});

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function chooseRandom(list) {
  return list[Math.floor(Math.random() * list.length)] || null;
}

export function installSpaceBackdrop(
  root = document.querySelector("[data-space-backdrop]"),
  {
    canvas = document.body,
    motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)")
  } = {}
) {
  if (root?.[SPACE_BACKDROP_RUNTIME_KEY] && !root.classList.contains("is-animated")) {
    root[SPACE_BACKDROP_RUNTIME_KEY].destroy();
  }

  const runtime = createSpaceBackdropRuntime(root, {
    canvas,
    variantClassName: "is-animated"
  });

  if (!runtime || runtime.syncMotion) {
    return runtime;
  }

  const trailEls = Array.from(root.querySelectorAll(SPACE_BACKDROP_TRAIL_SELECTOR));
  const trailTimers = new WeakMap();
  const trailAnimationEndHandlers = new Map();

  const clearTrailTimer = (trailEl) => {
    const timerId = trailTimers.get(trailEl);

    if (!timerId) {
      return;
    }

    window.clearTimeout(timerId);
    trailTimers.delete(trailEl);
  };

  const configureTrail = (trailEl) => {
    const directionPool = chooseRandom(SPACE_BACKDROP_TRAIL_PROFILE.directionPools);

    if (!directionPool) {
      return;
    }

    const angleDeg = randomBetween(directionPool.angleMinDeg, directionPool.angleMaxDeg);
    const travelVmax = randomBetween(
      SPACE_BACKDROP_TRAIL_PROFILE.travelMinVmax,
      SPACE_BACKDROP_TRAIL_PROFILE.travelMaxVmax
    );
    const angleRad = (angleDeg * Math.PI) / 180;
    const distanceX = Math.cos(angleRad) * travelVmax;
    const distanceY = Math.sin(angleRad) * travelVmax;

    trailEl.style.top = `${randomBetween(directionPool.topMin, directionPool.topMax).toFixed(1)}%`;
    trailEl.style.left = `${randomBetween(directionPool.leftMin, directionPool.leftMax).toFixed(1)}%`;
    trailEl.style.setProperty("--space-trail-angle", `${angleDeg.toFixed(1)}deg`);
    trailEl.style.setProperty("--space-trail-distance-x", `${distanceX.toFixed(2)}vmax`);
    trailEl.style.setProperty("--space-trail-distance-y", `${distanceY.toFixed(2)}vmax`);
    trailEl.style.setProperty(
      "--space-trail-duration",
      `${Math.round(randomBetween(SPACE_BACKDROP_TRAIL_PROFILE.durationMinMs, SPACE_BACKDROP_TRAIL_PROFILE.durationMaxMs))}ms`
    );
    trailEl.style.setProperty(
      "--space-trail-length",
      `${randomBetween(SPACE_BACKDROP_TRAIL_PROFILE.lengthMinRem, SPACE_BACKDROP_TRAIL_PROFILE.lengthMaxRem).toFixed(2)}rem`
    );
  };

  const launchTrail = (trailEl) => {
    if (!trailEl || motionQuery.matches) {
      return;
    }

    clearTrailTimer(trailEl);
    configureTrail(trailEl);
    trailEl.classList.remove("is-active");
    void trailEl.offsetWidth;
    trailEl.classList.add("is-active");
  };

  const scheduleTrail = (
    trailEl,
    delayMinMs = SPACE_BACKDROP_TRAIL_PROFILE.delayMinMs,
    delayMaxMs = SPACE_BACKDROP_TRAIL_PROFILE.delayMaxMs
  ) => {
    clearTrailTimer(trailEl);

    if (!trailEl || motionQuery.matches) {
      return;
    }

    const delayMs = Math.round(randomBetween(delayMinMs, delayMaxMs));
    const timerId = window.setTimeout(() => {
      launchTrail(trailEl);
    }, delayMs);

    trailTimers.set(trailEl, timerId);
  };

  const stopTrails = () => {
    trailEls.forEach((trailEl) => {
      clearTrailTimer(trailEl);
      trailEl.classList.remove("is-active");
    });
  };

  const startTrails = () => {
    stopTrails();

    if (motionQuery.matches) {
      return;
    }

    trailEls.forEach((trailEl, index) => {
      scheduleTrail(
        trailEl,
        SPACE_BACKDROP_TRAIL_PROFILE.initialDelayMinMs + (index * 420),
        SPACE_BACKDROP_TRAIL_PROFILE.initialDelayMaxMs + (index * 980)
      );
    });
  };

  const syncMotion = () => {
    if (motionQuery.matches) {
      stopTrails();
      return;
    }

    startTrails();
  };

  const removeMotionChangeListener = addMediaChangeListener(motionQuery, syncMotion);

  trailEls.forEach((trailEl) => {
    const handleAnimationEnd = () => {
      trailEl.classList.remove("is-active");
      scheduleTrail(trailEl);
    };

    trailAnimationEndHandlers.set(trailEl, handleAnimationEnd);
    trailEl.addEventListener("animationend", handleAnimationEnd);
  });

  runtime.addCleanup(removeMotionChangeListener);
  runtime.addCleanup(stopTrails);
  runtime.addCleanup(() => {
    trailEls.forEach((trailEl) => {
      const handleAnimationEnd = trailAnimationEndHandlers.get(trailEl);

      if (handleAnimationEnd) {
        trailEl.removeEventListener("animationend", handleAnimationEnd);
      }
    });

    trailAnimationEndHandlers.clear();
  });
  runtime.syncMotion = syncMotion;
  syncMotion();
  return runtime;
}

const space = globalThis.space || (globalThis.space = {});
space.visual = space.visual || {};
space.visual.installAnimatedBackdrop = installSpaceBackdrop;
space.visual.destroyAnimatedBackdrop = destroySpaceBackdrop;

export { destroySpaceBackdrop };
