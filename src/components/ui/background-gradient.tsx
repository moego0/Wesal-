"use client";

import React from "react";

/**
 * Aceternity UI BackgroundGradient component.
 *
 * Provides a glowing ambient multi-color radial gradient border with smooth
 * hover transitions and backdrop effects.
 */
export function BackgroundGradient({
  children,
  className = "",
  containerClassName = "",
  animate = true,
  variant = "rose-amber",
}: {
  children?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  animate?: boolean;
  variant?: "rose-amber" | "teal-cyan" | "violet-indigo" | "amber-orange" | "rainbow";
}) {
  const gradientByVariant = {
    "rose-amber":
      "bg-[radial-gradient(circle_farthest-side_at_0_100%,#f43f5e,transparent),radial-gradient(circle_farthest-side_at_100%_0,#f59e0b,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#ef4444,transparent),radial-gradient(circle_farthest-side_at_0_0,#f97316,#141316)]",
    "amber-orange":
      "bg-[radial-gradient(circle_farthest-side_at_0_100%,#f59e0b,transparent),radial-gradient(circle_farthest-side_at_100%_0,#ea580c,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#d97706,transparent),radial-gradient(circle_farthest-side_at_0_0,#fbbf24,#141316)]",
    "teal-cyan":
      "bg-[radial-gradient(circle_farthest-side_at_0_100%,#0d9488,transparent),radial-gradient(circle_farthest-side_at_100%_0,#06b6d4,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#10b981,transparent),radial-gradient(circle_farthest-side_at_0_0,#3b82f6,#141316)]",
    "violet-indigo":
      "bg-[radial-gradient(circle_farthest-side_at_0_100%,#8b5cf6,transparent),radial-gradient(circle_farthest-side_at_100%_0,#6366f1,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#a855f7,transparent),radial-gradient(circle_farthest-side_at_0_0,#ec4899,#141316)]",
    rainbow:
      "bg-[radial-gradient(circle_farthest-side_at_0_100%,#00ccb1,transparent),radial-gradient(circle_farthest-side_at_100%_0,#7b61ff,transparent),radial-gradient(circle_farthest-side_at_100%_100%,#ffc414,transparent),radial-gradient(circle_farthest-side_at_0_0,#1ca0fb,#141316)]",
  }[variant];

  return (
    <div className={`relative p-[1.5px] group ${containerClassName}`}>
      <div
        className={`absolute inset-0 rounded-2xl z-[1] opacity-75 group-hover:opacity-100 blur-md transition duration-500 will-change-transform ${gradientByVariant} ${
          animate ? "motion-safe:animate-pulse" : ""
        }`}
      />
      <div
        className={`absolute inset-0 rounded-2xl z-[1] will-change-transform ${gradientByVariant}`}
      />
      <div className={`relative z-10 rounded-[15px] ${className}`}>
        {children}
      </div>
    </div>
  );
}
