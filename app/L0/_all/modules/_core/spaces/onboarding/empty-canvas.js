export { loadEmptyCanvasExamples } from "./empty-canvas-examples.js";

const TAU = Math.PI * 2;
const EMPTY_SPACE_FLOAT_PROFILE = Object.freeze({
  orbitPeriodMs: 12400,
  rotationAmplitude: 3.2,
  rotationPeriodMs: 17600,
  xRadius: 7.2,
  yRadius: 8.2
});
const EMPTY_SPACE_TEXT_FLOAT_PROFILES = Object.freeze([
  {
    orbitPeriodMs: 13600,
    phase: 0.2,
    rotationAmplitude: 1.4,
    rotationPeriodMs: 18800,
    xRadius: 5.8,
    yRadius: 6.2
  },
  {
    orbitPeriodMs: 14900,
    phase: 1.35,
    rotationAmplitude: 1.1,
    rotationPeriodMs: 17100,
    xRadius: 4.4,
    yRadius: 5.1
  },
  {
    orbitPeriodMs: 14300,
    phase: 2.45,
    rotationAmplitude: 1.35,
    rotationPeriodMs: 19400,
    xRadius: 5.4,
    yRadius: 6
  },
  {
    orbitPeriodMs: 15500,
    phase: 3.1,
    rotationAmplitude: 1,
    rotationPeriodMs: 18200,
    xRadius: 4.2,
    yRadius: 4.8
  }
]);
const EMPTY_SPACE_SEQUENCE_SPEED_MULTIPLIER = 0.75;
const EMPTY_SPACE_SEQUENCE_DELAY_SCALE = 0.75 * EMPTY_SPACE_SEQUENCE_SPEED_MULTIPLIER;
function scaleSequenceDelay(delayMs) {
  return Math.round(delayMs * EMPTY_SPACE_SEQUENCE_DELAY_SCALE);
}
const EMPTY_SPACE_SEQUENCE_PROFILE = Object.freeze({
  buttonsDelayMs: scaleSequenceDelay(2400),
  examplesLineDelayMs: scaleSequenceDelay(2400),
  firstLineDelayMs: scaleSequenceDelay(500),
  introGapDelayMs: scaleSequenceDelay(2400),
  lineSwapGapDelayMs: scaleSequenceDelay(3600),
  promptLineDelayMs: scaleSequenceDelay(2200)
});

function createElement(tagName, className = "", textContent = "") {
  const element = document.createElement(tagName);

  if (className) {
    element.className = className;
  }

  if (textContent) {
    element.textContent = textContent;
  }

  return element;
}

function convertHexColorToRgbTriplet(colorValue, fallback = "148, 188, 255") {
  const match = String(colorValue ?? "").trim().match(/^#([0-9a-f]{6})$/iu);

  if (!match) {
    return fallback;
  }

  const hex = match[1];
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16)
  ].join(", ");
}

function combineCleanupFunctions(...cleanups) {
  return () => {
    cleanups.forEach((cleanup) => {
      if (typeof cleanup === "function") {
        cleanup();
      }
    });
  };
}

function getOnscreenAgentStore() {
  const Alpine = globalThis.Alpine;

  if (!Alpine || typeof Alpine.store !== "function") {
    return null;
  }

  const store = Alpine.store("onscreenAgent");
  return store && typeof store === "object" ? store : null;
}

function syncChatExampleButtons(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) {
    return;
  }

  const onscreenAgentStore = getOnscreenAgentStore();
  const isInactive = Boolean(onscreenAgentStore?.isExamplePromptInactive);
  const reason = onscreenAgentStore?.examplePromptInactiveReason || "active";

  buttons.forEach((button) => {
    if (!(button instanceof HTMLElement)) {
      return;
    }

    button.classList.toggle("is-chat-inactive", isInactive);
    button.dataset.chatState = reason;
  });
}

function startChatExampleButtonStatusSync(buttons) {
  if (!Array.isArray(buttons) || !buttons.length) {
    return () => {};
  }

  syncChatExampleButtons(buttons);

  const Alpine = globalThis.Alpine;
  const onscreenAgentStore = getOnscreenAgentStore();
  if (
    Alpine &&
    onscreenAgentStore &&
    typeof Alpine.effect === "function" &&
    typeof Alpine.release === "function"
  ) {
    const effectRef = Alpine.effect(() => {
      syncChatExampleButtons(buttons);
    });

    return () => {
      Alpine.release(effectRef);
    };
  }

  const fallbackTimer = window.setInterval(() => {
    syncChatExampleButtons(buttons);
  }, 250);

  return () => {
    window.clearInterval(fallbackTimer);
  };
}

function applyEmptyCanvasTextPose(element, x, y, rotation) {
  if (!element) {
    return;
  }

  element.style.setProperty("--spaces-empty-text-float-x", `${x.toFixed(1)}px`);
  element.style.setProperty("--spaces-empty-text-float-y", `${y.toFixed(1)}px`);
  element.style.setProperty("--spaces-empty-text-float-rotate", `${rotation.toFixed(1)}deg`);
}

function applyFloatingTitlePose(element, x, y, rotation) {
  if (!element) {
    return;
  }

  element.style.setProperty("--spaces-empty-title-float-x", `${x.toFixed(1)}px`);
  element.style.setProperty("--spaces-empty-title-float-y", `${y.toFixed(1)}px`);
  element.style.setProperty("--spaces-empty-title-rotate", `${rotation.toFixed(1)}deg`);
}

function startEmptyCanvasSequenceAnimation(elements, motionQuery = null, options = {}) {
  const stageHost = elements?.content || elements || null;
  const skipTarget = elements?.copy || null;
  const playSequence = options.playSequence !== false;

  if (!stageHost) {
    return () => {};
  }

  const stageSteps = [
    ["intro-primary", EMPTY_SPACE_SEQUENCE_PROFILE.firstLineDelayMs],
    ["intro-secondary", EMPTY_SPACE_SEQUENCE_PROFILE.introGapDelayMs],
    ["swap-gap", EMPTY_SPACE_SEQUENCE_PROFILE.lineSwapGapDelayMs],
    ["prompt", EMPTY_SPACE_SEQUENCE_PROFILE.promptLineDelayMs],
    ["examples-copy", EMPTY_SPACE_SEQUENCE_PROFILE.examplesLineDelayMs],
    ["buttons", EMPTY_SPACE_SEQUENCE_PROFILE.buttonsDelayMs]
  ];
  let stageTimeouts = [];

  const clearTimers = () => {
    stageTimeouts.forEach((timeoutId) => {
      window.clearTimeout(timeoutId);
    });
    stageTimeouts = [];
  };

  const setStage = (stage) => {
    if (!stageHost.isConnected) {
      return;
    }

    stageHost.dataset.emptyCanvasStage = stage;
  };

  const jumpToFinalStage = () => {
    clearTimers();
    setStage("buttons");
  };

  if (!playSequence) {
    jumpToFinalStage();
    return () => {};
  }

  const start = () => {
    clearTimers();

    if (!stageHost.isConnected) {
      return;
    }

    if (motionQuery?.matches) {
      jumpToFinalStage();
      return;
    }

    let elapsedMs = 0;
    stageSteps.forEach(([stageName, delayMs], index) => {
      elapsedMs += delayMs;
      const timeoutId = window.setTimeout(() => {
        setStage(stageName);
      }, elapsedMs);
      stageTimeouts.push(timeoutId);

      if (index === 0 && delayMs === 0) {
        setStage(stageName);
      }
    });
  };

  const handleMotionPreferenceChange = () => {
    start();
  };
  const handleSkipClick = () => {
    jumpToFinalStage();
  };
  const handleSkipKeydown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    jumpToFinalStage();
  };

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", handleMotionPreferenceChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(handleMotionPreferenceChange);
    }
  }

  if (skipTarget) {
    skipTarget.addEventListener("click", handleSkipClick);
    skipTarget.addEventListener("keydown", handleSkipKeydown);
  }

  start();

  return () => {
    clearTimers();

    if (motionQuery) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", handleMotionPreferenceChange);
      } else if (typeof motionQuery.removeListener === "function") {
        motionQuery.removeListener(handleMotionPreferenceChange);
      }
    }

    if (skipTarget) {
      skipTarget.removeEventListener("click", handleSkipClick);
      skipTarget.removeEventListener("keydown", handleSkipKeydown);
    }
  };
}

function startEmptyCanvasTextFloatAnimation(elements, motionQuery = null) {
  const floaters = Array.isArray(elements)
    ? elements.filter(Boolean).map((element, index) => ({
      element,
      profile: EMPTY_SPACE_TEXT_FLOAT_PROFILES[index % EMPTY_SPACE_TEXT_FLOAT_PROFILES.length]
    }))
    : [];

  if (!floaters.length) {
    return () => {};
  }

  let frame = 0;
  let startTime = 0;

  const resetPose = () => {
    floaters.forEach(({ element }) => {
      applyEmptyCanvasTextPose(element, 0, 0, 0);
    });
  };

  const step = (timestamp) => {
    const hasConnectedElement = floaters.some(({ element }) => element.isConnected);

    if (!hasConnectedElement) {
      frame = 0;
      return;
    }

    if (motionQuery?.matches) {
      frame = 0;
      startTime = 0;
      resetPose();
      return;
    }

    if (!startTime) {
      startTime = timestamp;
    }

    const elapsed = timestamp - startTime;
    floaters.forEach(({ element, profile }) => {
      if (!element.isConnected) {
        return;
      }

      const orbitAngle = ((elapsed / profile.orbitPeriodMs) * TAU) + profile.phase;
      const rotationAngle = ((elapsed / profile.rotationPeriodMs) * TAU) + (profile.phase * 0.75);

      applyEmptyCanvasTextPose(
        element,
        Math.cos(orbitAngle) * profile.xRadius,
        Math.sin(orbitAngle) * profile.yRadius,
        Math.sin(rotationAngle) * profile.rotationAmplitude
      );
    });

    frame = window.requestAnimationFrame(step);
  };

  const start = () => {
    window.cancelAnimationFrame(frame);
    frame = 0;
    startTime = 0;
    resetPose();

    if (motionQuery?.matches) {
      return;
    }

    frame = window.requestAnimationFrame(step);
  };

  const handleMotionPreferenceChange = () => {
    start();
  };

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", handleMotionPreferenceChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(handleMotionPreferenceChange);
    }
  }

  start();

  return () => {
    window.cancelAnimationFrame(frame);
    frame = 0;

    if (motionQuery) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", handleMotionPreferenceChange);
      } else if (typeof motionQuery.removeListener === "function") {
        motionQuery.removeListener(handleMotionPreferenceChange);
      }
    }

    resetPose();
  };
}

function startFloatingTitleAnimation(element, motionQuery = null) {
  if (!element) {
    return () => {};
  }

  let frame = 0;
  let startTime = 0;

  const resetPose = () => {
    applyFloatingTitlePose(element, 0, 0, 0);
  };

  const step = (timestamp) => {
    if (!element.isConnected) {
      frame = 0;
      return;
    }

    if (motionQuery?.matches) {
      frame = 0;
      startTime = 0;
      resetPose();
      return;
    }

    if (!startTime) {
      startTime = timestamp;
    }

    const elapsed = timestamp - startTime;
    const orbitAngle = ((elapsed / EMPTY_SPACE_FLOAT_PROFILE.orbitPeriodMs) * TAU) + 0.45;
    const rotationAngle = ((elapsed / EMPTY_SPACE_FLOAT_PROFILE.rotationPeriodMs) * TAU) + 1.1;

    applyFloatingTitlePose(
      element,
      Math.cos(orbitAngle) * EMPTY_SPACE_FLOAT_PROFILE.xRadius,
      Math.sin(orbitAngle) * EMPTY_SPACE_FLOAT_PROFILE.yRadius,
      Math.sin(rotationAngle) * EMPTY_SPACE_FLOAT_PROFILE.rotationAmplitude
    );

    frame = window.requestAnimationFrame(step);
  };

  const start = () => {
    window.cancelAnimationFrame(frame);
    frame = 0;
    startTime = 0;
    resetPose();

    if (!element.isConnected || motionQuery?.matches) {
      return;
    }

    frame = window.requestAnimationFrame(step);
  };

  const handleMotionPreferenceChange = () => {
    start();
  };

  if (motionQuery) {
    if (typeof motionQuery.addEventListener === "function") {
      motionQuery.addEventListener("change", handleMotionPreferenceChange);
    } else if (typeof motionQuery.addListener === "function") {
      motionQuery.addListener(handleMotionPreferenceChange);
    }
  }

  start();

  return () => {
    window.cancelAnimationFrame(frame);
    frame = 0;

    if (motionQuery) {
      if (typeof motionQuery.removeEventListener === "function") {
        motionQuery.removeEventListener("change", handleMotionPreferenceChange);
      } else if (typeof motionQuery.removeListener === "function") {
        motionQuery.removeListener(handleMotionPreferenceChange);
      }
    }

    resetPose();
  };
}

export function createLoadingCanvasState() {
  const root = createElement("section", "spaces-empty-canvas spaces-loading-canvas");
  const content = createElement("div", "spaces-empty-canvas-content spaces-loading-canvas-content");
  const title = createElement("h2", "spaces-empty-canvas-title spaces-loading-canvas-title");

  title.appendChild(createElement("span", "spaces-empty-canvas-line", "Loading space..."));
  content.appendChild(title);
  root.appendChild(content);

  return { root, title };
}

export function startLoadingCanvasAnimation(loadingCanvas, motionQuery = null) {
  return startFloatingTitleAnimation(loadingCanvas?.title || null, motionQuery);
}

export function createEmptyCanvasState(exampleDefinitions = [], { initialStage = "boot", onExampleError } = {}) {
  const reportExampleError =
    typeof onExampleError === "function"
      ? onExampleError
      : (error, details = {}) => {
          console.error("[spaces/onboarding] empty canvas example click failed", details, error);
        };
  const root = createElement("section", "spaces-empty-canvas");
  const content = createElement("div", "spaces-empty-canvas-content");
  const copy = createElement("div", "spaces-empty-canvas-copy");
  const primarySlot = createElement("div", "spaces-empty-canvas-copy-slot spaces-empty-canvas-copy-slot-primary");
  const secondarySlot = createElement("div", "spaces-empty-canvas-copy-slot spaces-empty-canvas-copy-slot-secondary");
  const firstFloater = createElement("div", "spaces-empty-canvas-floater spaces-empty-canvas-floater-intro-primary");
  const secondFloater = createElement("div", "spaces-empty-canvas-floater spaces-empty-canvas-floater-intro-secondary");
  const thirdFloater = createElement("div", "spaces-empty-canvas-floater spaces-empty-canvas-floater-prompt");
  const fourthFloater = createElement("div", "spaces-empty-canvas-floater spaces-empty-canvas-floater-examples-copy");
  const firstText = createElement("p", "spaces-empty-canvas-text spaces-empty-canvas-text-intro-primary", "Just an empty space here");
  const secondText = createElement("p", "spaces-empty-canvas-text spaces-empty-canvas-text-intro-secondary", "for now");
  const thirdText = createElement(
    "p",
    "spaces-empty-canvas-text spaces-empty-canvas-text-prompt",
    "Tell your agent what to create"
  );
  const fourthText = createElement(
    "p",
    "spaces-empty-canvas-text spaces-empty-canvas-text-examples-copy",
    "or try one of the examples above"
  );
  const examples = createElement("div", "spaces-empty-canvas-examples");
  const chatExampleButtons = [];

  copy.tabIndex = 0;
  copy.setAttribute("role", "button");
  copy.setAttribute("aria-label", "Show all empty space guidance");
  content.dataset.emptyCanvasStage = initialStage === "buttons" ? "buttons" : "boot";
  firstFloater.appendChild(firstText);
  secondFloater.appendChild(secondText);
  thirdFloater.appendChild(thirdText);
  fourthFloater.appendChild(fourthText);
  primarySlot.append(firstFloater, thirdFloater);
  secondarySlot.append(secondFloater, fourthFloater);
  copy.append(primarySlot, secondarySlot);
  exampleDefinitions.forEach((exampleDefinition) => {
    const button = createElement("button", "spaces-empty-canvas-example");
    const accentColor = String(exampleDefinition.color || "").trim() || "#94bcff";
    const contentRow = createElement("span", "spaces-empty-canvas-example-content");
    const iconBadge = createElement("span", "spaces-empty-canvas-example-icon-badge");
    const icon = createElement("x-icon", "spaces-empty-canvas-example-icon", exampleDefinition.icon || "chat_bubble");
    const label = createElement("span", "spaces-empty-canvas-example-label", exampleDefinition.text);

    button.type = "button";
    button.title = exampleDefinition.text;
    if (exampleDefinition.kind === "chat") {
      button.classList.add("spaces-empty-canvas-example-chat");
      chatExampleButtons.push(button);
    }
    button.style.setProperty("--spaces-empty-example-accent", accentColor);
    button.style.setProperty("--spaces-empty-example-accent-rgb", convertHexColorToRgbTriplet(accentColor));
    iconBadge.appendChild(icon);
    contentRow.append(iconBadge, label);
    button.appendChild(contentRow);
      button.addEventListener("click", async (event) => {
      button.disabled = true;

      try {
        const onscreenAgentStore = getOnscreenAgentStore();
        const onscreenAgentRuntime =
          globalThis.space?.onscreenAgent &&
          typeof globalThis.space.onscreenAgent === "object"
            ? globalThis.space.onscreenAgent
            : null;
        const showInactiveBubble =
          typeof onscreenAgentRuntime?.showExamplePromptInactiveBubble === "function"
            ? (options = {}) => onscreenAgentRuntime.showExamplePromptInactiveBubble(options)
            : typeof onscreenAgentStore?.showExamplePromptInactiveBubble === "function"
              ? (options = {}) => onscreenAgentStore.showExamplePromptInactiveBubble(options)
              : null;

        if (
          exampleDefinition.kind === "chat" &&
          onscreenAgentStore?.isExamplePromptInactive &&
          showInactiveBubble
        ) {
          await showInactiveBubble();
          return;
        }

        await exampleDefinition.execute(event);
      } catch (error) {
        reportExampleError(error, {
          exampleId: exampleDefinition.id,
          labelText: exampleDefinition.text,
          promptText: exampleDefinition.prompt
        });
      } finally {
        button.disabled = false;
      }
    });
    examples.appendChild(button);
  });

  content.append(examples, copy);
  root.appendChild(content);
  const cleanup = startChatExampleButtonStatusSync(chatExampleButtons);

  return {
    cleanup,
    copy,
    content,
    floaters: [firstFloater, secondFloater, thirdFloater, fourthFloater],
    root
  };
}

export function startEmptyCanvasAnimations(emptyCanvas, motionQuery = null, options = {}) {
  return combineCleanupFunctions(
    emptyCanvas?.cleanup,
    startEmptyCanvasTextFloatAnimation(emptyCanvas?.floaters, motionQuery),
    startEmptyCanvasSequenceAnimation(emptyCanvas, motionQuery, options)
  );
}
