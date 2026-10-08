/**
 * mc-blocks.js — full, opaque Minecraft blocks and their average texture
 * colours (sRGB), for .schem export and the "Minecraft blocks" palette.
 * Colours only; no textures are shipped. All blocks exist in 1.21.
 */

export const MC_BLOCKS = [
    // Concrete
    ['white_concrete', 207, 213, 214], ['orange_concrete', 224, 97, 1], ['magenta_concrete', 169, 48, 159],
    ['light_blue_concrete', 36, 137, 199], ['yellow_concrete', 241, 175, 21], ['lime_concrete', 94, 169, 25],
    ['pink_concrete', 214, 101, 143], ['gray_concrete', 55, 58, 62], ['light_gray_concrete', 125, 125, 115],
    ['cyan_concrete', 21, 119, 136], ['purple_concrete', 100, 32, 156], ['blue_concrete', 45, 47, 143],
    ['brown_concrete', 96, 60, 32], ['green_concrete', 73, 91, 36], ['red_concrete', 142, 33, 33],
    ['black_concrete', 8, 10, 15],
    // Wool
    ['white_wool', 234, 236, 237], ['orange_wool', 241, 118, 20], ['magenta_wool', 190, 69, 180],
    ['light_blue_wool', 58, 175, 217], ['yellow_wool', 249, 198, 40], ['lime_wool', 112, 185, 26],
    ['pink_wool', 238, 141, 172], ['gray_wool', 63, 68, 72], ['light_gray_wool', 142, 142, 135],
    ['cyan_wool', 21, 138, 145], ['purple_wool', 122, 42, 173], ['blue_wool', 53, 57, 157],
    ['brown_wool', 114, 72, 41], ['green_wool', 85, 110, 28], ['red_wool', 161, 39, 35],
    ['black_wool', 21, 21, 26],
    // Terracotta
    ['terracotta', 152, 94, 68], ['white_terracotta', 210, 178, 161], ['orange_terracotta', 162, 84, 38],
    ['magenta_terracotta', 150, 88, 109], ['light_blue_terracotta', 113, 109, 138], ['yellow_terracotta', 186, 133, 35],
    ['lime_terracotta', 104, 118, 53], ['pink_terracotta', 162, 78, 79], ['gray_terracotta', 58, 42, 36],
    ['light_gray_terracotta', 135, 107, 98], ['cyan_terracotta', 87, 91, 91], ['purple_terracotta', 118, 70, 86],
    ['blue_terracotta', 74, 60, 91], ['brown_terracotta', 77, 51, 36], ['green_terracotta', 76, 83, 42],
    ['red_terracotta', 143, 61, 47], ['black_terracotta', 37, 23, 16],
    // Stone, wood, sand and other building blocks
    ['stone', 126, 126, 126], ['cobblestone', 128, 127, 128], ['smooth_stone', 159, 159, 159],
    ['andesite', 136, 136, 137], ['diorite', 189, 188, 189], ['granite', 149, 103, 86],
    ['deepslate', 80, 80, 83], ['blackstone', 42, 36, 41], ['tuff', 108, 109, 103],
    ['oak_planks', 162, 131, 79], ['spruce_planks', 115, 85, 49], ['birch_planks', 192, 175, 121],
    ['jungle_planks', 160, 115, 81], ['acacia_planks', 168, 90, 50], ['dark_oak_planks', 67, 43, 20],
    ['mangrove_planks', 118, 54, 49], ['cherry_planks', 227, 179, 173], ['crimson_planks', 101, 49, 71],
    ['warped_planks', 43, 105, 99], ['sandstone', 216, 203, 155], ['red_sandstone', 181, 98, 31],
    ['snow_block', 249, 254, 254], ['quartz_block', 236, 230, 223], ['obsidian', 15, 11, 25],
    ['bricks', 151, 98, 83], ['mud_bricks', 137, 104, 79], ['prismarine', 99, 156, 151],
    ['dark_prismarine', 52, 92, 76], ['end_stone', 219, 222, 158], ['purpur_block', 170, 126, 170],
    ['netherrack', 98, 38, 38], ['nether_bricks', 44, 21, 26], ['clay', 160, 166, 179],
    ['packed_ice', 141, 180, 250], ['moss_block', 89, 110, 45], ['honeycomb_block', 229, 148, 30],
    ['gold_block', 246, 208, 62], ['iron_block', 220, 220, 220], ['emerald_block', 42, 203, 88],
    ['lapis_block', 31, 67, 140], ['diamond_block', 98, 237, 228], ['redstone_block', 175, 24, 5],
    ['coal_block', 16, 15, 15], ['glowstone', 171, 131, 84],
].map(([name, r, g, b]) => ({ id: `minecraft:${name}`, rgb: [r, g, b] }));
