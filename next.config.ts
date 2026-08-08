import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next 16 writes its own AGENTS.md/CLAUDE.md on first boot. This project's
  // agent instructions live in .claude/ and CLAUDE.md at the user level; a
  // generated file competing with them is worse than none.
  agentRules: false,
};

export default nextConfig;
