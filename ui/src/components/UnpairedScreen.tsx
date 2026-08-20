/*
 * entangle — unpaired screen
 *
 * Terminal state for a desktop session that ended or restarted. Only a fresh
 * pairing can recover it, so this screen does not poll or retry automatically.
 */

import "../styles/unpaired.css";

export default function UnpairedScreen() {
  return (
    <section className="unpaired" data-testid="unpaired" role="status" aria-live="polite">
      <span className="rings rings--lg" aria-hidden="true" />
      <h1 className="unpaired__title">Session ended or restarted</h1>
      <p className="unpaired__body">
        This phone is no longer paired. Run <code className="unpaired__command">entangle</code> in
        your terminal and scan the new QR code.
      </p>
      <ol className="unpaired__steps">
        <li className="unpaired__step">Return to the machine running opencode.</li>
        <li className="unpaired__step">
          Run <code className="unpaired__command">entangle</code>.
        </li>
        <li className="unpaired__step">Scan the QR code it prints.</li>
      </ol>
      <p className="unpaired__note">This page will not reconnect on its own</p>
    </section>
  );
}
