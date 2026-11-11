import torch.nn as nn

from latin1 import Latin


class UsesLatin(nn.Module):
    def forward(self, x):
        return x


class ChildOfLatin(Latin):
    def forward(self, x):
        return x
