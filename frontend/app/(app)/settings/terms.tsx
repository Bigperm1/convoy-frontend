import React from "react";
import LegalPage from "../../../src/components/LegalPage";

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      updated="—"
      intro="These terms govern your use of Convoy. By using the app you agree to them. Replace this placeholder with your finalized terms."
      sections={[
        { heading: "Using Convoy", body: "You must be legally allowed to drive and follow all traffic laws. Convoy is an aid, not a substitute for safe, attentive driving. [Placeholder.]" },
        { heading: "Accounts", body: "You’re responsible for your account and the accuracy of your profile. [Placeholder.]" },
        { heading: "Acceptable Use", body: "Don’t misuse comms, share hazardous or unlawful content, or interfere with other drivers. [Placeholder.]" },
        { heading: "Location & Navigation", body: "Routing, ETAs, hazards, and speed data may be inaccurate or delayed. Always rely on real-world conditions and road signs. [Placeholder.]" },
        { heading: "Disclaimers & Liability", body: "The app is provided “as is”. Add your warranty disclaimers and liability limits here. [Placeholder.]" },
        { heading: "Changes & Contact", body: "We may update these terms; continued use means acceptance. Questions: support@convoy.app. [Placeholder.]" },
      ]}
    />
  );
}
