import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/globals.css";
import { beforeRender } from "../../pages/lib/boot";
import { ApproveApp } from "../../pages/approve/ApproveApp";

void beforeRender().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ApproveApp />
    </StrictMode>,
  ),
);
