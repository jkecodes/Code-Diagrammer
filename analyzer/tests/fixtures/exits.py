import sys

import torch.nn as nn


class Exits(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 2)

    def forward(self, x):
        sys.exit(3)
