import { Rocket, Shield, Cpu, Sparkles, Loader } from 'lucide-react';

interface LandingPageProps {
  onConnect: () => void;
  isConnecting?: boolean;
}

const FEATURES = [
  {
    icon: Rocket,
    title: 'Deploy in Seconds',
    description: 'Drop a manifest file and your app is live. No infrastructure to manage.',
  },
  {
    icon: Shield,
    title: 'Decentralized Hosting',
    description: 'Your apps run on distributed compute providers. No single point of failure.',
  },
  {
    icon: Cpu,
    title: 'Flexible Resources',
    description: 'From small static sites to GPU-powered ML inference. Pick the right tier.',
  },
];

export function LandingPage({ onConnect, isConnecting }: LandingPageProps) {
  return (
    <div className="landing-page">
      <div className="landing-hero">
        <div className="landing-logo">
          <Sparkles className="w-10 h-10 text-primary-400" aria-hidden="true" />
        </div>
        <h1 className="landing-title">
          <span className="gradient-text">Barney</span>
        </h1>
        <p className="landing-subtitle">
          Deploy apps to decentralized compute with a conversation.
        </p>
        <button
          type="button"
          onClick={onConnect}
          className="btn btn-primary btn-lg landing-cta"
          disabled={isConnecting}
        >
          {isConnecting ? (
            <>
              <Loader className="w-4 h-4 animate-spin" aria-hidden="true" />
              Connecting...
            </>
          ) : (
            'Get Started'
          )}
        </button>
        <p className="landing-hint">
          {isConnecting
            ? 'Reconnecting to your previous session...'
            : 'Sign in'}
        </p>
      </div>

      <div className="landing-features">
        {FEATURES.map((feature) => (
          <div key={feature.title} className="landing-feature-card">
            <div className="landing-feature-icon">
              <feature.icon className="w-6 h-6" aria-hidden="true" />
            </div>
            <h3 className="landing-feature-title">{feature.title}</h3>
            <p className="landing-feature-desc">{feature.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
