import assert from "node:assert/strict";
import test from "node:test";

import { SPACES_ROUTE_PATH } from "../app/L0/_all/modules/_core/spaces/constants.js";
import {
  AVAILABLE_SPACES_TRANSIENT_KEY,
  buildAvailableSpacesTransientSection,
  buildCurrentSpaceContextTags,
  buildCurrentSpaceWidgetsTransientSection,
  CURRENT_SPACE_WIDGETS_TRANSIENT_KEY
} from "../app/L0/_all/modules/_core/spaces/prompt-context.js";

test("buildCurrentSpaceContextTags exposes in-space tags with the current id", () => {
  assert.equal(buildCurrentSpaceContextTags("space-7"), "space:open space:id:space-7");
  assert.equal(buildCurrentSpaceContextTags(""), "");
});

test("buildAvailableSpacesTransientSection builds the compact space list", () => {
  const section = buildAvailableSpacesTransientSection({
    spaceList: [
      { displayTitle: "Research", id: "space-2" },
      { id: "space-3", title: "" }
    ]
  });

  assert.deepEqual(section, {
    content: [
      "spaces (id|title)↓",
      "space-2|Research",
      "space-3|Untitled"
    ].join("\n"),
    heading: "available spaces",
    key: AVAILABLE_SPACES_TRANSIENT_KEY,
    order: 110
  });
});

test("buildAvailableSpacesTransientSection shows [empty] when no spaces exist", () => {
  assert.deepEqual(buildAvailableSpacesTransientSection({ spaceList: [] }), {
    content: [
      "spaces (id|title)↓",
      "[empty]"
    ].join("\n"),
    heading: "available spaces",
    key: AVAILABLE_SPACES_TRANSIENT_KEY,
    order: 110
  });
});

test("buildCurrentSpaceWidgetsTransientSection summarizes live widget layout", () => {
  const section = buildCurrentSpaceWidgetsTransientSection({
    currentSpaceId: "space-7",
    currentSpaceTitle: "Board",
    routePath: SPACES_ROUTE_PATH,
    widgets: [
      {
        col: 1,
        cols: 4,
        id: "weather",
        name: "Weather",
        renderStatus: "ok",
        row: 2,
        rows: 3,
        state: "expanded"
      },
      {
        col: 5,
        cols: 6,
        id: "news-feed",
        name: "News Feed",
        renderStatus: "error",
        row: 2,
        rows: 5,
        state: "minimized"
      }
    ]
  });

  assert.deepEqual(section, {
    content: [
      "space id|title",
      "space-7|Board",
      "",
      "widgets (id|name|col|row|cols|rows|state|render status)↓",
      "weather|Weather|1|2|4|3|expanded|ok",
      "news-feed|News Feed|5|2|6|5|minimized|error"
    ].join("\n"),
    heading: "current space widgets",
    key: CURRENT_SPACE_WIDGETS_TRANSIENT_KEY,
    order: 210
  });
});

test("buildCurrentSpaceWidgetsTransientSection shows [empty] for an empty current space", () => {
  const section = buildCurrentSpaceWidgetsTransientSection({
    currentSpaceId: "space-8",
    currentSpaceTitle: "",
    routePath: SPACES_ROUTE_PATH,
    widgets: []
  });

  assert.equal(
    section?.content,
    [
      "space id|title",
      "space-8|Untitled",
      "",
      "widgets (id|name|col|row|cols|rows|state|render status)↓",
      "[empty]"
    ].join("\n")
  );
});
