import Hero from '@/components/Hero';
import LiveAgentDemo from '@/components/LiveAgentDemo';
import CodeExamplePicker from '@/components/CodeExamplePicker';

export default function HomePage() {
  return (
    <>
      <Hero demoSlot={<LiveAgentDemo />} />

      <section className="mx-auto max-w-container px-margin-mobile pb-20 md:px-margin-desktop">
        <h2 className="mb-6 text-headline-md font-semibold text-on-surface">
          Three integrations. Pick one — start in five minutes.
        </h2>
        <CodeExamplePicker />
      </section>
    </>
  );
}
