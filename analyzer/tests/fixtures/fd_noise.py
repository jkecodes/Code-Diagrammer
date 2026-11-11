import os

import torch.nn as nn


class FdNoise(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc = nn.Linear(4, 2)

    def forward(self, x):
        os.system("echo hello-from-child")
        return self.fc(x)
