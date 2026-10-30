import { randomInt } from 'node:crypto'

// Short, easy-to-say words for session codes like "amber-otter-river" (~4.6M combinations).
const WORDS = `amber anchor apple arrow aspen atlas autumn badge bamboo banjo basil beacon berry birch bison blossom
breeze brook cactus cadet camel canary candle canyon cargo cedar cello chalk cherry cider citrus clover cobalt comet
coral cotton crane crater cricket crystal cypress daisy delta denim desert dolphin dove dragon dune eagle echo ember
falcon fern fiddle finch fjord flint forest fossil fox galaxy garnet gecko ginger glacier granite grove harbor hazel
heron hickory honey horizon husky iris island ivory jade jasmine jelly juniper kayak kettle kiwi koala lagoon lantern
lemon lilac lime linen lotus lunar lynx magnet mango maple marble meadow melon mint mirror mocha moon moss nectar
nimbus nova oak oasis ocean olive onyx opal orbit orchid otter owl panda papaya parrot peach pearl pebble pepper
pine planet plum polar poppy prism pumpkin quartz quill rabbit radish rain raven reef ribbon river robin rocket
rose ruby saffron sage salmon sapphire satin sequoia shadow shell sierra silver sky slate snow sparrow spruce
squirrel star stone storm summit sun swan tango teal thistle thunder tiger timber topaz tulip tundra turtle umber
valley velvet violet walnut willow winter wolf wren yarrow zebra zephyr`
  .split(/\s+/)
  .filter(Boolean)

export function randomCode(): string {
  const pick = () => WORDS[randomInt(WORDS.length)]
  return `${pick()}-${pick()}-${pick()}`
}
