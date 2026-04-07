<script lang="ts">
  let greetMsg = $state("");
  let name = $state("");

  async function greet() {
    greetMsg = `Hello, ${name}! Welcome to Novelist.`;
  }
</script>

<main class="flex flex-col items-center justify-center h-screen bg-gray-900 text-white">
  <h1 class="text-4xl font-bold mb-8">Novelist</h1>

  <form class="flex gap-2 mb-4" onsubmit={(e) => { e.preventDefault(); greet(); }}>
    <input
      class="px-3 py-2 rounded bg-gray-800 border border-gray-600 text-white"
      id="greet-input"
      placeholder="Enter a name..."
      bind:value={name}
    />
    <button
      class="px-4 py-2 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium"
      type="submit"
    >
      Greet
    </button>
  </form>

  <p class="text-lg">{greetMsg}</p>
</main>
