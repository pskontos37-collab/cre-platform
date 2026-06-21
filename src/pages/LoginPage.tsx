export default function LoginPage() {
  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-8 w-full max-w-md">
        <h1 className="text-2xl font-semibold text-white mb-2">CRE Platform</h1>
        <p className="text-gray-400 text-sm mb-8">Sign in to your account</p>
        <p className="text-amber-400 text-sm border border-amber-900 bg-amber-950 rounded p-3">
          Connect your Supabase project to enable authentication.
          Copy <code className="font-mono">.env.example</code> to <code className="font-mono">.env</code> and fill in your project URL and anon key.
        </p>
      </div>
    </div>
  )
}
