/**
 * Who to write to about this app. The routing service it uses (FOSSGIS's OSRM server) asks that the email address of whoever runs a
 * site that uses it is easy to find, so it is shown where the services are used. Whoever builds their own copy sets VITE_CONTACT_EMAIL
 * to their own address.
 */
const CONTACT_EMAIL: string = String(import.meta.env.VITE_CONTACT_EMAIL || 'skupaaustralia@gmail.com')

/** A line saying who to write to, with the address as a link. */
export function Contact() {
  return (
    <p className="footnote contact">
      Questions about this app, or about how it uses the OpenStreetMap map and routing services: <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
    </p>
  )
}
