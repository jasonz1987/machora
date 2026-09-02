#!/usr/bin/env node

// Compatibility entry point for installations created before the Machora rename.
console.warn("rdev has been renamed to machora; use the `machora` command instead.");
await import("./machora.mjs");
