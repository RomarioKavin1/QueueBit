import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/globals.css";
import { AppMain } from "../../pages/app/AppMain";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppMain />
  </StrictMode>,
);
