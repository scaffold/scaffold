import { animals, colors, uniqueNamesGenerator } from 'unique-names-generator';
import { EntropyProvider } from '../interfaces/EntropyProvider.ts';

export const generateSillyName = (entropyProvider: EntropyProvider) =>
  uniqueNamesGenerator({
    dictionaries: [colors, animals],
    separator: '-',
    seed: Math.floor(entropyProvider.randomNumber() * (2 ** 32)),
  });
