import { Suspense } from "react";
import { ExplorerApp } from "./components/explorer-app";

export default function HomePage() {
  return (
    <Suspense fallback={null}>
      <ExplorerApp />
    </Suspense>
  );
}
