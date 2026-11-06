import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/globals.css";
import { beforeRender } from "../../pages/lib/boot";
import { AppMain } from "../../pages/app/AppMain";

void beforeRender().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <AppMain />
    </StrictMode>,
  ),
);
