import React from "react";
import LegalPage from "../../../src/components/LegalPage";

export default function SafetyPage() {
  return (
    <LegalPage
      title="Safety Guidelines"
      updated="—"
      intro="Convoy is built for the road, but nothing matters more than driving safely. Replace this placeholder with your finalized safety guidance."
      sections={[
        { heading: "Eyes on the Road", body: "Set your destination, communities, and preferences before you start driving. Use Scout’s hands-free voice replies instead of tapping. [Placeholder.]" },
        { heading: "Comms & Convoy", body: "Keep push-to-talk brief. Never let coordinating with your crew pull your attention from driving. [Placeholder.]" },
        { heading: "Hazard Reports", body: "Only report hazards when it’s safe — ideally as a passenger or via voice. Reports are crowd-sourced and may be inaccurate. [Placeholder.]" },
        { heading: "Speed & Limits", body: "Speed-limit and camera data can be wrong or outdated. Always obey posted signs and drive to conditions. [Placeholder.]" },
        { heading: "Emergencies", body: "In an emergency, pull over safely and call local emergency services. Convoy is not an emergency service. [Placeholder.]" },
      ]}
    />
  );
}
