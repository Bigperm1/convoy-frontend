import React from "react";
import LegalPage from "../../../src/components/LegalPage";
import { SAFETY_GUIDELINES } from "../../../src/legalContent";

export default function SafetyPage() {
  return <LegalPage {...SAFETY_GUIDELINES} />;
}
