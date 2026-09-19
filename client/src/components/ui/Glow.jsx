import React from "react";

export default function Glow({ className = "", variant = "above" }) {
  return (
    <div
      className={`absolute ${
        variant === "above" ? "top-0" : "bottom-0"
      } left-1/2 -translate-x-1/2 w-[900px] h-[900px] rounded-full bg-primary/30 blur-3xl ${className}`}
    />
  );
}
